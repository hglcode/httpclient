/**
 * 限流 / 并发控制：undici interceptor 层的排队闸门。
 *
 * 两个正交维度：
 * - maxConcurrent：单 client 并发上限（超出排队，FIFO）；
 * - requestsPerSecond：令牌桶限速（容量 = burst，匀速补充）。
 *
 * 失败模式：
 * - queue-full：队列长度达 queueLimit，立即快速失败（不消耗重试预算外的等待）；
 * - queue-timeout：排队超过 queueTimeoutMs；
 * 两者均抛 RateLimitRejectedError（retryable=true，可安全重试）。
 *
 * 已知边界（见 DESIGN.md 限制章节）：
 * 排队期间调用方 abort 不会撤销排队中的 dispatch（undici dispatch 层无 signal），
 * 该请求最终仍会发出、响应被丢弃。
 */
import { RateLimitRejectedError } from '../errors.js';
import type { RateLimitOptions } from '../types.js';
import type { DispatchController, DispatchHandler, UndiciInterceptor } from './utils.js';
import { BaseDispatchHandler, rejectAsync } from './utils.js';
import type { Duplex } from 'node:stream';

export interface RequestLimiterSnapshot {
    active: number;
    queued: number;
    /** 令牌桶剩余令牌（未启用限速时为 null） */
    availableTokens: number | null;
}

export interface ResolvedRateLimitOptions {
    maxConcurrent: number;
    queueLimit: number;
    queueTimeoutMs: number;
    rps: number;
    burst: number;
}

export const DEFAULT_RATE_LIMIT: Readonly<
    Omit<ResolvedRateLimitOptions, 'maxConcurrent' | 'rps'>
> = Object.freeze({
    queueLimit: 0,
    queueTimeoutMs: 60_000,
    burst: 0, // 0 = 未指定，按 rps 推导
});

export function resolveRateLimitOptions(
    options?: RateLimitOptions | false,
): ResolvedRateLimitOptions | null {
    if (options == null || options === false) return null;
    const rps = options.requestsPerSecond ?? Number.POSITIVE_INFINITY;
    const burst = options.burst ?? (Number.isFinite(rps) ? Math.max(1, Math.ceil(rps)) : 0);
    return {
        maxConcurrent: options.maxConcurrent ?? Number.POSITIVE_INFINITY,
        queueLimit: options.queueLimit ?? DEFAULT_RATE_LIMIT.queueLimit,
        queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_RATE_LIMIT.queueTimeoutMs,
        rps,
        burst,
    };
}

class Waiter {
    settled = false;
    readonly promise: Promise<void>;
    resolve!: () => void;
    reject!: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.promise = new Promise<void>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

/** 纯限流器，与传输层解耦，可独立单测 */
export class RequestLimiter {
    readonly #options: ResolvedRateLimitOptions;
    #active = 0;
    #queue: Waiter[] = [];
    #tokens: number;
    #lastRefill: number;
    #refillTimer: ReturnType<typeof setTimeout> | null = null;
    #disposed = false;
    #disposeError: Error | null = null;

    constructor(options: ResolvedRateLimitOptions) {
        this.#options = options;
        this.#tokens = options.burst;
        this.#lastRefill = Date.now();
    }

    /**
     * 获取发送许可。resolve 即获得并发槽与令牌；
     * reject 为 RateLimitRejectedError（queue-full / queue-timeout / disposed）。
     */
    acquire(): Promise<void> {
        if (this.#disposed) {
            return Promise.reject(this.#disposeError ?? new Error('limiter disposed'));
        }

        const waiter = new Waiter();
        if (this.#canGrantNow(Date.now())) {
            this.#grant(waiter, Date.now());
            return waiter.promise;
        }

        if (this.#options.queueLimit > 0 && this.#queue.length >= this.#options.queueLimit) {
            return Promise.reject(
                new RateLimitRejectedError(
                    'queue-full',
                    `Rate limit queue is full (limit=${this.#options.queueLimit})`,
                ),
            );
        }

        if (this.#options.queueTimeoutMs > 0) {
            waiter.timer = setTimeout(() => {
                if (waiter.settled) return;
                waiter.settled = true;
                this.#removeFromQueue(waiter);
                waiter.reject(
                    new RateLimitRejectedError(
                        'queue-timeout',
                        `Request waited in queue for more than ${this.#options.queueTimeoutMs}ms`,
                    ),
                );
                this.#pump();
            }, this.#options.queueTimeoutMs);
            waiter.timer.unref?.();
        }

        this.#queue.push(waiter);
        this.#pump();
        return waiter.promise;
    }

    /** 请求结束（成功/失败/升级）后归还并发槽 */
    release(): void {
        this.#active = Math.max(0, this.#active - 1);
        this.#pump();
    }

    /** 优雅关闭：拒绝所有排队中的等待者（已授予的不受影响） */
    dispose(error?: Error): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#disposeError =
            error ?? new Error('limiter disposed: client is closing');
        if (this.#refillTimer != null) {
            clearTimeout(this.#refillTimer);
            this.#refillTimer = null;
        }
        const queued = this.#queue;
        this.#queue = [];
        for (const waiter of queued) {
            if (waiter.settled) continue;
            waiter.settled = true;
            if (waiter.timer != null) clearTimeout(waiter.timer);
            waiter.reject(this.#disposeError);
        }
    }

    snapshot(now: number = Date.now()): RequestLimiterSnapshot {
        if (Number.isFinite(this.#options.rps)) this.#refill(now);
        return {
            active: this.#active,
            queued: this.#queue.length,
            availableTokens: Number.isFinite(this.#options.rps)
                ? Math.floor(this.#tokens)
                : null,
        };
    }

    #canGrantNow(now: number): boolean {
        if (this.#disposed) return false;
        if (this.#active >= this.#options.maxConcurrent) return false;
        if (Number.isFinite(this.#options.rps)) {
            this.#refill(now);
            return this.#tokens >= 1;
        }
        return true;
    }

    #grant(waiter: Waiter, now: number): void {
        if (Number.isFinite(this.#options.rps)) {
            this.#refill(now);
            this.#tokens -= 1;
        }
        this.#active += 1;
        waiter.settled = true;
        if (waiter.timer != null) clearTimeout(waiter.timer);
        waiter.resolve();
    }

    #pump(now: number = Date.now()): void {
        while (this.#queue.length > 0 && !this.#disposed) {
            if (!this.#canGrantNow(now)) break;
            const waiter = this.#queue.shift()!;
            if (waiter.settled) continue;
            this.#grant(waiter, now);
        }
        this.#scheduleRefillTimer();
    }

    /** 令牌不足导致队列阻塞时，安排一次未来的补充计时 */
    #scheduleRefillTimer(): void {
        if (this.#disposed || this.#refillTimer != null) return;
        if (this.#queue.length === 0 || !Number.isFinite(this.#options.rps)) return;
        const deficit = 1 - this.#tokens;
        if (deficit <= 0) return;
        const waitMs = Math.max(1, Math.ceil((deficit / this.#options.rps) * 1000));
        this.#refillTimer = setTimeout(() => {
            this.#refillTimer = null;
            this.#pump();
        }, waitMs);
        this.#refillTimer.unref?.();
    }

    #refill(now: number): void {
        if (!Number.isFinite(this.#options.rps)) return;
        const elapsedSec = (now - this.#lastRefill) / 1000;
        if (elapsedSec <= 0) return;
        this.#tokens = Math.min(this.#options.burst, this.#tokens + elapsedSec * this.#options.rps);
        this.#lastRefill = now;
    }

    #removeFromQueue(waiter: Waiter): void {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
    }
}

/* ---------------------- undici interceptor ---------------------- */

/** 归还并发槽的响应观察者 */
class ReleaseHandler extends BaseDispatchHandler {
    readonly #release: () => void;
    #released = false;

    constructor(handler: DispatchHandler, release: () => void) {
        super(handler);
        this.#release = release;
    }

    override onResponseEnd(
        controller: DispatchController,
        trailers: Record<string, string | string[] | undefined>,
    ): void {
        this.#releaseOnce();
        return super.onResponseEnd(controller, trailers);
    }

    override onResponseError(
        controller: DispatchController,
        error: Error,
    ): void {
        this.#releaseOnce();
        return super.onResponseError(controller, error);
    }

    override onRequestUpgrade(
        controller: DispatchController,
        statusCode: number,
        headers: Record<string, string | string[] | undefined>,
        socket: Duplex,
    ): void {
        this.#releaseOnce();
        return super.onRequestUpgrade(controller, statusCode, headers, socket);
    }

    #releaseOnce(): void {
        if (this.#released) return;
        this.#released = true;
        this.#release();
    }
}

/**
 * 创建限流拦截器。
 * 组合位置：最外层 —— 限流拒绝不应消耗熔断统计（那是下游健康信号），
 * 熔断打开时也不应空耗令牌/并发槽。
 */
export function rateLimitInterceptor(limiter: RequestLimiter): UndiciInterceptor {
    return (dispatch) => (opts, handler) => {
        limiter
            .acquire()
            .then(() => {
                const wrapped = new ReleaseHandler(handler, () => limiter.release());
                try {
                    dispatch(opts, wrapped);
                } catch (error) {
                    // dispatch 同步抛出（参数非法 / client 已关闭）
                    limiter.release();
                    rejectAsync(
                        handler,
                        error instanceof Error ? error : new Error(String(error)),
                    );
                }
            }, (error: Error) => {
                rejectAsync(handler, error);
            });
        return true;
    };
}
