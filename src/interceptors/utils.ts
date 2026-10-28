/**
 * undici 拦截器通用类型与工具。
 *
 * undici v7 契约（lib/dispatcher/dispatcher.js#compose）：
 * - Interceptor: (dispatch) => (opts, handler) => boolean
 * - compose 按参数顺序逐层包裹：**先传入的在内层（贴近 Agent）**，
 *   链式调用 `.compose(A).compose(B)` 中 B 在外层；
 * - compose 返回原 dispatcher 的 Proxy（close/destroy 直通，不经拦截器）；
 * - handler 走「新接口」（onRequestStart / onResponseStart / ...），
 *   旧接口已标记 @deprecated，两端由 undici 的 WrapHandler / UnwrapHandler
 *   自动适配；新式 handler 必须实现 onResponseError（UnwrapHandler 强制）。
 */
import type { Dispatcher } from 'undici';

export type UndiciInterceptor = Dispatcher.DispatcherComposeInterceptor;
export type DispatchFn = Dispatcher.Dispatch;
export type DispatchOpts = Dispatcher.DispatchOptions;
export type DispatchHandler = Dispatcher.DispatchHandler;
export type DispatchController = Dispatcher.DispatchController;

/**
 * 响应侧观察者的类型安全基类。
 *
 * 官方 DecoratorHandler 的 .d.ts 尚未声明新接口（undici 类型迁移未完成），
 * 故自实现等价语义：持有 inner handler（新接口），子类按需覆写。
 * 注意：所有方法显式实现（不可选）—— UnwrapHandler 在错误路径上
 * 硬性要求 onResponseError 存在。
 */
export abstract class BaseDispatchHandler implements DispatchHandler {
    protected readonly inner: DispatchHandler;

    constructor(inner: DispatchHandler) {
        this.inner = inner;
    }

    onRequestStart(controller: DispatchController, context: unknown): void {
        this.inner.onRequestStart?.(controller, context);
    }

    onRequestUpgrade(
        controller: DispatchController,
        statusCode: number,
        headers: Record<string, string | string[] | undefined>,
        socket: import('node:stream').Duplex,
    ): void {
        this.inner.onRequestUpgrade?.(controller, statusCode, headers, socket);
    }

    onResponseStart(
        controller: DispatchController,
        statusCode: number,
        headers: Record<string, string | string[] | undefined>,
        statusMessage: string | undefined,
    ): boolean | void {
        return this.inner.onResponseStart?.(controller, statusCode, headers, statusMessage);
    }

    onResponseData(controller: DispatchController, chunk: Buffer): boolean | void {
        return this.inner.onResponseData?.(controller, chunk);
    }

    onResponseEnd(
        controller: DispatchController,
        trailers: Record<string, string | string[] | undefined>,
    ): void {
        this.inner.onResponseEnd?.(controller, trailers);
    }

    onResponseError(controller: DispatchController, error: Error): void {
        this.inner.onResponseError?.(controller, error);
    }
}

/**
 * 未经真实 dispatch 即失败（熔断打开 / 排队被拒）时的错误递送。
 *
 * 必须异步递送：保证 dispatch() 先返回、回调后触发，
 * 与 undici 内部异步错误路径语义一致。
 */
export function rejectAsync(handler: DispatchHandler, error: Error): void {
    const controller = createNoopController(error);
    // void：有意为之的异步递送（保证 dispatch() 先返回），无需等待结果
    void Promise.resolve().then(() => {
        handler.onResponseError?.(controller, error);
    });
}

/** 请求从未真正开始时的空控制器（abort/pause/resume 均为无害 no-op） */
function createNoopController(reason: Error): DispatchController {
    return {
        get aborted(): boolean {
            return true;
        },
        get paused(): boolean {
            return false;
        },
        get reason(): Error | null {
            return reason;
        },
        abort(): void {
            /* noop */
        },
        pause(): void {
            /* noop */
        },
        resume(): void {
            /* noop */
        },
    };
}
