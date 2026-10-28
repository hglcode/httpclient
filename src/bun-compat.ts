/**
 * 全局 fetch 兼容层：在无法使用 undici Dispatcher 子系统的运行时
 * （典型：Bun）以 client 层等价实现复现拦截链语义。
 *
 * 背景（为什么需要这个文件）：
 * Bun 将裸说明符 `undici` 解析到内置兼容层，其 Agent/Dispatcher 是
 * 没有任何实例方法的空壳（compose/dispatch/close 均缺失）；即使绕过
 * 说明符强制加载 node_modules 里的真 undici，也会因 Bun 缺少 Node
 * 22.14+ 的 `util.markAsUncloneable` 而在初始化时崩溃。因此在这样的
 * 环境里拦截器链无法落在 dispatcher 层，改在 fetch 调用前后等价接线：
 *
 *   限流 acquire/release → 熔断准入/记账 → Cookie 注入/收集 → 全局 fetch
 *
 * 重定向语义对齐：undici fetch 在 follow 模式下的每一跳都会重新走完整
 * dispatch 链（限流重新占槽、熔断重新记账、cookie 逐跳存取）。本实现
 * 以 `redirect: 'manual'` + 手动循环达到完全相同的逐跳语义。
 *
 * 与 dispatcher 路径的已知差异（详见 DESIGN.md）：
 * - 熔断在「响应头到达」时记账（dispatcher 路径在 onResponseEnd）；
 * - agent 连接池调优选项不生效（运行时自管连接池）；
 * - 限流槽通过无背压流桥在 body 完结时归还。
 */
import { Agent } from 'undici';
import type { CookieJar } from 'tough-cookie';
import { CircuitOpenError } from './errors.js';
import { isBodyReplayable } from './retry.js';
import type { CircuitBreaker } from './interceptors/circuit-breaker.js';
import type { RequestLimiter } from './interceptors/rate-limit.js';

/** 需要跟随的 3xx 状态码（fetch spec） */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** 手动重定向上限，与 undici fetch 的内部上限对齐 */
const MAX_REDIRECT_HOPS = 20;

/* ------------------------------------------------------------------ *
 * 能力探测
 * ------------------------------------------------------------------ */

let dispatcherSupport: boolean | undefined;

/**
 * 探测当前运行时的 `undici` 是否携带可用的 Dispatcher 子系统。
 * Node（npm 安装的 undici 7/8）→ true；Bun（内置空壳）→ false。
 * 结果惰性缓存，进程生命周期内不变。
 */
export function supportsUndiciDispatcher(): boolean {
    if (dispatcherSupport === undefined) {
        try {
            const proto = (
                Agent as unknown as { prototype?: { compose?: unknown; dispatch?: unknown } }
            ).prototype;
            dispatcherSupport =
                typeof proto?.compose === 'function' && typeof proto?.dispatch === 'function';
        } catch {
            dispatcherSupport = false;
        }
    }
    return dispatcherSupport;
}

/* ------------------------------------------------------------------ *
 * 全局 fetch 路径
 * ------------------------------------------------------------------ */

export interface GlobalFetchDeps {
    /** 限流器（null = 未启用） */
    limiter: RequestLimiter | null;
    /** 熔断器（null = 未启用） */
    breaker: CircuitBreaker | null;
    /** 计入熔断失败的响应状态码 */
    failureStatusCodes: ReadonlySet<number>;
    /** cookie jar（null = 未启用） */
    jar: CookieJar | null;
}

export interface GlobalFetchCall {
    url: string | URL;
    init: Omit<RequestInit, 'headers' | 'method' | 'body' | 'signal' | 'redirect'> & {
        method: string;
        headers: Record<string, string>;
        body?: unknown;
        redirect?: 'follow' | 'manual' | 'error';
    };
    signal?: AbortSignal;
}

/**
 * 经由全局 fetch 发起单次尝试（不含重试），完整等价于
 * 限流 → 熔断 → cookie → Agent 的拦截链语义。
 */
export async function fetchViaGlobal(call: GlobalFetchCall, deps: GlobalFetchDeps): Promise<Response> {
    const { limiter, breaker, jar } = deps;
    const failureCodes = deps.failureStatusCodes;
    const userRedirect = (call.init.redirect ?? 'follow') as 'follow' | 'manual' | 'error';

    let url = call.url;
    let method = call.init.method;
    let headers: Record<string, string> = { ...call.init.headers };
    let body: unknown = call.init.body;
    let hops = 0;

    for (;;) {
        /* -------- 限流（最外层）：拒绝不污染熔断统计 -------- */
        if (limiter != null) await limiter.acquire();
        let released = false;
        const release = (): void => {
            if (!released) {
                released = true;
                limiter?.release();
            }
        };
        // 最终响应若已把归还挂到 body 完结（bridge），finally 不再兑付
        let deferredRelease = false;

        try {
            /* -------- 熔断准入 -------- */
            let probe = false;
            if (breaker != null) {
                const admission = breaker.beforeRequest();
                if (!admission.allowed) {
                    throw new CircuitOpenError(breaker.snapshot(), admission.retryInMs);
                }
                probe = admission.probe;
            }

            let settled = false;
            try {
                /* -------- cookie 注入（调用方显式 Cookie 头优先） -------- */
                const hopHeaders: Record<string, string> = { ...headers };
                if (jar != null && !('cookie' in hopHeaders)) {
                    const cookie = getCookieStringSafe(jar, url);
                    if (cookie !== '') hopHeaders.cookie = cookie;
                }

                const response = await fetch(url, {
                    ...call.init,
                    method,
                    headers: hopHeaders,
                    body: body as RequestInit['body'],
                    // 手动循环仅在 follow 模式接管；manual / error 原样透传
                    redirect: userRedirect === 'follow' ? 'manual' : userRedirect,
                    signal: call.signal,
                    // 流式 body 需要 duplex（WHATWG fetch spec 要求）
                    ...(body != null && !isBodyReplayable(body) ? { duplex: 'half' as const } : {}),
                });

                /* -------- cookie 收集（每一跳） -------- */
                if (jar != null) storeSetCookiesSafe(jar, url, response);

                /* -------- 熔断记账（响应头到达即结算） -------- */
                if (breaker != null) {
                    settled = true;
                    if (failureCodes.has(response.status)) breaker.onFailure(probe);
                    else breaker.onSuccess(probe);
                }

                /* -------- 手动重定向循环 -------- */
                if (userRedirect === 'follow' && REDIRECT_STATUSES.has(response.status)) {
                    const location = response.headers.get('location');
                    // 307/308 要求原样转发 body；不可重放的流式 body 不跟随（返回 3xx 由调用方决策）
                    const canFollow =
                        location != null &&
                        (response.status !== 307 && response.status !== 308
                            ? true
                            : isBodyReplayable(body));
                    if (canFollow) {
                        if (++hops > MAX_REDIRECT_HOPS) {
                            throw new TypeError(
                                `Failed to fetch: exceeded ${MAX_REDIRECT_HOPS} redirects`,
                            );
                        }
                        const nextUrl = new URL(location, url);
                        await response.body?.cancel().catch(() => {});
                        const transformed = redirectTransform(response.status, method, headers, body);
                        url = nextUrl;
                        method = transformed.method;
                        headers = transformed.headers;
                        body = transformed.body;
                        // 本跳结束：归还限流槽，下一跳重新走完整链
                        release();
                        continue;
                    }
                }

                /* -------- 最终响应：限流槽挂到 body 完结时归还 -------- */
                const bridged =
                    limiter != null && response.body != null
                        ? bridgeBodyRelease(response, release)
                        : response;
                // fetch spec 语义：发生过重定向的最终响应 redirected = true
                if (hops > 0) markRedirected(bridged);
                if (bridged === response) {
                    // 未走桥接（或桥接失败已兑付）→ 立即归还
                    release();
                } else {
                    // 归还已挂到 body 完结，finally 不得提前兑付
                    deferredRelease = true;
                }
                return bridged;
            } catch (error) {
                // 传输错误计入熔断；CircuitOpenError 自身不记账（被拒的请求）
                if (breaker != null && !settled && !(error instanceof CircuitOpenError)) {
                    breaker.onFailure(probe);
                }
                throw error;
            }
        } finally {
            // 异常 / 重定向跳 / 未桥接响应的兑付路径；桥接分支不在此处释放
            if (!deferredRelease) release();
        }
    }
}

/* ------------------------------------------------------------------ *
 * 辅助函数
 * ------------------------------------------------------------------ */

/** fetch spec 的重定向方法转换：303 → GET；301/302 的 POST → GET（历史兼容） */
function redirectTransform(
    status: number,
    method: string,
    headers: Record<string, string>,
    body: unknown,
): { method: string; headers: Record<string, string>; body: unknown } {
    if (
        (status === 303 && method !== 'GET' && method !== 'HEAD') ||
        ((status === 301 || status === 302) && method === 'POST')
    ) {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (key === 'content-type' || key === 'content-length' || key === 'transfer-encoding') {
                continue;
            }
            next[key] = value;
        }
        return { method: 'GET', headers: next, body: undefined };
    }
    return { method, headers, body };
}

function getCookieStringSafe(jar: CookieJar, url: string | URL): string {
    try {
        return jar.getCookieStringSync(url.toString());
    } catch {
        return '';
    }
}

function storeSetCookiesSafe(jar: CookieJar, url: string | URL, response: Response): void {
    try {
        const cookies = response.headers.getSetCookie?.() ?? [];
        for (const cookie of cookies) {
            if (typeof cookie !== 'string' || cookie === '') continue;
            try {
                jar.setCookieSync(cookie, url.toString(), { http: true });
            } catch {
                // 单条无效 cookie 不影响响应本体
            }
        }
    } catch {
        // cookie 处理失败绝不影响响应
    }
}

/**
 * 在实例上遮蔽原型 getter，标记 redirected = true
 * （原生 fetch 的 follow 由实现内部标记；手动循环需补上）。
 */
function markRedirected(response: Response): void {
    if (response.redirected === true) return;
    try {
        Object.defineProperty(response, 'redirected', {
            value: true,
            enumerable: true,
            configurable: true,
            writable: false,
        });
    } catch {
        // 不可写环境下放弃标记（不影响状态码/头/body 语义）
    }
}

/**
 * 把「限流槽归还」挂到响应 body 的完结时机（读完 / 出错 / 取消），
 * 与 dispatcher 路径 onResponseEnd 归还槽位的语义对齐。
 * 无背压桥接保证：即使调用方从不读 body，源读完后也能触发归还。
 */
function bridgeBodyRelease(response: Response, release: () => void): Response {
    try {
        const bridge = new TransformStream<Uint8Array, Uint8Array>(
            undefined,
            { highWaterMark: Number.POSITIVE_INFINITY },
            { highWaterMark: Number.POSITIVE_INFINITY },
        );
        void response.body!.pipeTo(bridge.writable).then(release, release);
        return new Response(bridge.readable, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } catch {
        release();
        return response;
    }
}
