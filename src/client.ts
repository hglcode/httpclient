/**
 * HttpClient：fetch 风格的生产级 HTTP 客户端。
 *
 * 分层（自外向内）：
 *   client 层   —— URL 解析、头合并、超时/中止、重试、HttpError、遥测
 *   dispatcher  —— 限流(最外) → 熔断 → cookie(最内) → undici Agent
 *
 * Bun 等运行时无法使用 undici Dispatcher 子系统（详见 bun-compat.ts），
 * 此时拦截链等价落在 client 层（fetchViaGlobal），对外行为一致。
 *
 * fetch 主循环每次尝试新建超时 signal（AbortSignal.timeout 与用户 signal
 * 经 AbortSignal.any 合并，Node 22+ 原生支持），因此「单次超时 + 总重试预算」
 * 语义精确可控。
 */
import { randomUUID } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher, RequestInit as UndiciRequestInit, Response } from 'undici';
import type { CookieJar } from 'tough-cookie';
import { fetchViaGlobal, supportsUndiciDispatcher } from './bun-compat.js';
import type { GlobalFetchCall } from './bun-compat.js';
import {
    HttpError,
    HttpClientError,
    normalizeFetchError,
    RequestAbortedError,
} from './errors.js';
import { mergeHeaders, responseHeadersToRecord } from './headers.js';
import { exportCookies, createCookieJar, flushCookieStore } from './cookies.js';
import type { SerializedCookieJar } from './cookies.js';
import {
    computeRetryDelayMs,
    isBodyReplayable,
    isMethodRetryable,
    isRetryableStatus,
    resolveRetryOptions,
    type ResolvedRetryOptions,
} from './retry.js';
import { createLoggerBridge, StatsCollector, TelemetryBus } from './telemetry.js';
import { appendSearchParams, assertBaseUrl, resolveUrl } from './url.js';
import {
    CircuitBreaker,
    circuitBreakerInterceptor,
    resolveCircuitBreakerOptions,
    type CircuitBreakerSnapshot,
    type ResolvedCircuitBreakerOptions,
} from './interceptors/circuit-breaker.js';
import {
    rateLimitInterceptor,
    RequestLimiter,
    resolveRateLimitOptions,
    type RequestLimiterSnapshot,
} from './interceptors/rate-limit.js';
import { cookieInterceptor } from './interceptors/cookie-interceptor.js';
import type {
    FetchInit,
    HttpClientOptions,
    RetryDecision,
    StatsSnapshot,
    TelemetryEvent,
    TelemetryEventRequestEnd,
    TelemetryEventRequestStart,
} from './types.js';

/** HttpError 携带的最大响应体快照（防止大 body 打爆内存/日志） */
const HTTP_ERROR_BODY_LIMIT = 64 * 1024;

export class HttpClient {
    readonly baseURL: string;
    readonly jar: CookieJar | null;

    readonly #defaultHeaders: Record<string, string>;
    readonly #defaultTimeout: number | undefined;
    readonly #throwOnHttpError: boolean;
    readonly #retryOptions: ResolvedRetryOptions | null;

    readonly #agent: Agent | null;
    readonly #dispatcher: Dispatcher | null;
    /** true = undici dispatcher 拦截链；false = 全局 fetch 等价路径（Bun 等） */
    readonly #dispatcherMode: boolean;
    readonly #cbOptions: ResolvedCircuitBreakerOptions | null;
    readonly #breaker: CircuitBreaker | null;
    readonly #limiter: RequestLimiter | null;

    readonly #bus = new TelemetryBus();
    readonly #stats: StatsCollector | null;
    #closed = false;

    constructor(options: HttpClientOptions = {}) {
        this.baseURL = options.baseURL ?? '';
        assertBaseUrl(this.baseURL);

        const cookiesOption = options.cookies === false ? null : (options.cookies ?? {});
        this.jar =
            cookiesOption == null ? null : createCookieJar(cookiesOption, this.baseURL);

        this.#defaultHeaders = mergeHeaders(options.headers, undefined);
        this.#defaultTimeout = options.timeout;
        this.#throwOnHttpError = options.throwOnHttpError ?? false;
        this.#retryOptions = resolveRetryOptions(options.retry);

        /* ---------------- 熔断 / 限流状态机（两种路径共用） ---------------- */
        const cbOptions = resolveCircuitBreakerOptions(options.circuitBreaker);
        this.#cbOptions = cbOptions;
        if (cbOptions != null) {
            this.#breaker = new CircuitBreaker(cbOptions);
            this.#breaker.onStateChange = (from, to) => {
                this.#emit({ type: 'circuit-breaker:state-change', from, to, timestamp: Date.now() });
            };
        } else {
            this.#breaker = null;
        }

        const rlOptions = resolveRateLimitOptions(options.rateLimit);
        this.#limiter = rlOptions != null ? new RequestLimiter(rlOptions) : null;

        /* ---------------- undici Agent 与拦截链（能力探测） ---------------- */
        this.#dispatcherMode = supportsUndiciDispatcher();
        if (this.#dispatcherMode) {
            this.#agent = new Agent(buildAgentOptions(options));
            let dispatcher: Dispatcher = this.#agent;

            // 内层：cookie（贴近传输，任何失败路径都不产生多余 jar 操作）
            if (this.jar != null) {
                dispatcher = dispatcher.compose(cookieInterceptor(this.jar));
            }

            // 中层：熔断（只统计真正到达网络的请求）
            if (this.#breaker != null) {
                dispatcher = dispatcher.compose(
                    circuitBreakerInterceptor(this.#breaker, cbOptions!.failureStatusCodes),
                );
            }

            // 外层：限流（拒绝不污染熔断统计；熔断打开时空耗令牌）
            if (this.#limiter != null) {
                dispatcher = dispatcher.compose(rateLimitInterceptor(this.#limiter));
            }

            this.#dispatcher = dispatcher;
        } else {
            // Bun 等运行时：undici 被内置空壳替换，拦截链等价落在 client 层
            this.#agent = null;
            this.#dispatcher = null;
        }

        /* ---------------- 遥测 ---------------- */
        const telemetry = options.telemetry ?? {};
        if (telemetry.onEvent != null) this.#bus.addListener(telemetry.onEvent);
        if (telemetry.logger != null && telemetry.logger !== false) {
            this.#bus.addListener(createLoggerBridge(telemetry.logger, telemetry.logLevel ?? 'info'));
        }
        this.#stats = telemetry.collectStats === false ? null : new StatsCollector();
        if (this.#stats != null) {
            const stats = this.#stats;
            this.#bus.addListener((event) => stats.handle(event));
        }
    }

    /**
     * 发起请求（fetch 语义）。
     *
     * - 返回 undici Response（Web 标准：res.ok / res.status / res.json() ...）；
     * - 非 2xx 默认不抛错，可用 throwOnHttpError 开启；
     * - 重试对调用方完全透明，仅遥测事件可见；
     * - 用户 abort / 超时 / 熔断 / 限流拒绝 抛出类型树中的对应错误。
     */
    async fetch(input: string | URL, init: FetchInit = {}): Promise<Response> {
        if (this.#closed) {
            throw new RequestAbortedError('Client is closed', 'Client is closed');
        }

        const method = (init.method ?? 'GET').toUpperCase();

        // URL 解析 + 查询参数
        let url = resolveUrl(this.baseURL === '' ? undefined : this.baseURL, input);
        if (init.searchParams !== undefined) {
            url = appendSearchParams(url, init.searchParams);
        }

        // 头合并 + json 便捷参数
        const headers = mergeHeaders(this.#defaultHeaders, init.headers);
        let body: FetchInit['body'] = init.body;
        if (init.json !== undefined) {
            if (body != null && body !== '') {
                throw new TypeError('FetchInit: use either `json` or `body`, not both.');
            }
            body = JSON.stringify(init.json);
            headers['content-type'] ??= 'application/json';
        }

        const {
            headers: _headers,
            signal: _signal,
            body: _body,
            method: _method,
            timeout: _timeout,
            retry: _retry,
            json: _json,
            searchParams: _searchParams,
            throwOnHttpError: _throwOnHttpError,
            ...passthrough
        } = init;

        const retryOptions = resolveRetryOptions(init.retry, this.#retryOptions);
        const throwOnHttpError = init.throwOnHttpError ?? this.#throwOnHttpError;
        const timeoutMs = init.timeout ?? this.#defaultTimeout;
        const userSignal = init.signal ?? undefined;
        const bodyReplayable = isBodyReplayable(body);
        const maxAttempts = retryOptions != null ? 1 + retryOptions.maxRetries : 1;
        const requestId = randomUUID();
        const startedAt = performance.now();
        let attempt = 0;

        for (;;) {
            attempt += 1;
            // 每次尝试都发 start 事件（attempt 区分首试/重试，供统计与追踪）
            this.#emit({
                type: 'request:start',
                requestId,
                method,
                url,
                attempt,
                timestamp: Date.now(),
            } satisfies TelemetryEventRequestStart);
            // 每次尝试独立的超时信号：重试不会共享上一次的剩余时间
            const signal = combineSignals(userSignal, timeoutMs);

            try {
                // 按能力探测选择路径：dispatcher 拦截链 / 全局 fetch 等价实现
                const response: Response = this.#dispatcherMode
                    ? await undiciFetch(url, {
                          ...passthrough,
                          method,
                          headers,
                          body: body ?? undefined,
                          signal,
                          dispatcher: this.#dispatcher!,
                      } as UndiciRequestInit)
                    : ((await fetchViaGlobal(
                          {
                              url,
                              init: {
                                  ...passthrough,
                                  method,
                                  headers,
                                  body: body ?? undefined,
                              } as GlobalFetchCall['init'],
                              signal,
                          },
                          {
                              limiter: this.#limiter,
                              breaker: this.#breaker,
                              failureStatusCodes:
                                  this.#cbOptions?.failureStatusCodes ?? new Set<number>(),
                              jar: this.jar,
                          },
                      )) as unknown as Response);

                const retryEligible =
                    retryOptions != null &&
                    attempt < maxAttempts &&
                    !response.ok &&
                    isRetryableStatus(response.status, retryOptions) &&
                    isMethodRetryable(method, retryOptions) &&
                    bodyReplayable;

                if (retryEligible) {
                    // 先释放连接再退避
                    await cancelBody(response);
                    const delayMs = computeRetryDelayMs(
                        attempt + 1,
                        retryOptions,
                        response.headers.get('retry-after'),
                    );
                    const decision: RetryDecision = {
                        url,
                        method,
                        nextAttempt: attempt + 1,
                        status: response.status,
                        delayMs,
                    };
                    if (retryOptions!.canRetry?.(decision) !== false) {
                        this.#emitRetry(requestId, method, url, attempt + 1, delayMs, `HTTP ${response.status}`);
                        await sleepCancellable(delayMs, userSignal);
                        continue;
                    }
                }

                if (!response.ok && throwOnHttpError) {
                    const bodyText = await readBodyCapped(response, HTTP_ERROR_BODY_LIMIT);
                    throw new HttpError({
                        url,
                        status: response.status,
                        statusText: response.statusText,
                        headers: responseHeadersToRecord(response.headers),
                        body: bodyText,
                    });
                }

                this.#emitEnd(requestId, method, url, attempt, {
                    status: response.status,
                    durationMs: performance.now() - startedAt,
                });
                return response;
            } catch (error) {
                const normalized: HttpClientError =
                    error instanceof HttpClientError
                        ? error
                        : normalizeFetchError(error, { url, method, signal, timeoutMs });

                const retryEligible =
                    normalized.retryable &&
                    retryOptions != null &&
                    attempt < maxAttempts &&
                    isMethodRetryable(method, retryOptions) &&
                    bodyReplayable;

                if (retryEligible) {
                    const delayMs = computeRetryDelayMs(attempt + 1, retryOptions!, null);
                    const decision: RetryDecision = {
                        url,
                        method,
                        nextAttempt: attempt + 1,
                        error: normalized,
                        delayMs,
                    };
                    if (retryOptions!.canRetry?.(decision) !== false) {
                        this.#emitRetry(
                            requestId,
                            method,
                            url,
                            attempt + 1,
                            delayMs,
                            `${normalized.name}(${normalized.code})`,
                        );
                        await sleepCancellable(delayMs, userSignal);
                        continue;
                    }
                }

                this.#emitEnd(requestId, method, url, attempt, {
                    durationMs: performance.now() - startedAt,
                    error: normalized,
                });
                throw normalized;
            }
        }
    }

    /** 当前传输路径：true = undici dispatcher 拦截链；false = 全局 fetch 等价路径（Bun 等） */
    get dispatcherMode(): boolean {
        return this.#dispatcherMode;
    }

    /** 运行时统计快照（请求数/重试/错误/状态码分布/耗时分位数/熔断/限流） */
    get stats(): StatsSnapshot {
        return this.#stats != null
            ? this.#stats.snapshot(this.circuitBreakerSnapshot, this.rateLimitSnapshot)
            : {
                  inFlight: 0,
                  totalRequests: 0,
                  totalRetries: 0,
                  totalErrors: 0,
                  statusCounts: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, unknown: 0 },
                  duration: { count: 0, minMs: 0, maxMs: 0, p50: 0, p95: 0, p99: 0 },
                  circuitBreaker: this.circuitBreakerSnapshot,
                  rateLimit: this.rateLimitSnapshot,
              };
    }

    get circuitBreakerSnapshot(): CircuitBreakerSnapshot | null {
        return this.#breaker?.snapshot() ?? null;
    }

    get rateLimitSnapshot(): RequestLimiterSnapshot | null {
        return this.#limiter?.snapshot() ?? null;
    }

    /** 导出会话（tough-cookie 序列化格式） */
    exportSession(): SerializedCookieJar | null {
        return this.jar != null ? exportCookies(this.jar) : null;
    }

    /** 优雅关闭：拒绝排队请求 → 等待在途完成 → cookie 落盘 */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#limiter?.dispose(new RequestAbortedError('Client is closed', 'Client closed'));
        if (this.#dispatcher != null) await this.#dispatcher.close();
        if (this.jar != null) flushCookieStore(this.jar);
    }

    /** 强制关闭：立即断开在途请求连接 */
    async destroy(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#limiter?.dispose(new RequestAbortedError('Client is destroyed', 'Client destroyed'));
        if (this.#dispatcher != null) await this.#dispatcher.destroy();
        if (this.jar != null) flushCookieStore(this.jar);
    }

    #emit(event: TelemetryEvent): void {
        this.#bus.emit(event);
    }

    #emitRetry(
        requestId: string,
        method: string,
        url: string,
        nextAttempt: number,
        delayMs: number,
        reason: string,
    ): void {
        this.#emit({
            type: 'retry:scheduled',
            requestId,
            method,
            url,
            nextAttempt,
            delayMs,
            reason,
            timestamp: Date.now(),
        });
    }

    #emitEnd(
        requestId: string,
        method: string,
        url: string,
        attempts: number,
        outcome: { status: number; durationMs: number } | { durationMs: number; error: HttpClientError },
    ): void {
        const event: TelemetryEventRequestEnd = {
            type: 'request:end',
            requestId,
            method,
            url,
            attempts,
            durationMs: outcome.durationMs,
            timestamp: Date.now(),
        };
        if ('status' in outcome) event.status = outcome.status;
        else {
            event.error = {
                name: outcome.error.name,
                code: outcome.error.code,
                message: outcome.error.message,
            };
        }
        this.#emit(event);
    }
}

/* ------------------------------------------------------------------ *
 * 辅助函数
 * ------------------------------------------------------------------ */

type UndiciAgentOptions = NonNullable<ConstructorParameters<typeof Agent>[0]>;

function buildAgentOptions(options: HttpClientOptions): UndiciAgentOptions {
    const agent = options.agent;
    if (agent == null) return {};
    const out: UndiciAgentOptions = {};
    if (agent.connections !== undefined) out.connections = agent.connections;
    if (agent.pipelining !== undefined) out.pipelining = agent.pipelining;
    if (agent.keepAliveTimeout !== undefined) out.keepAliveTimeout = agent.keepAliveTimeout;
    if (agent.keepAliveMaxTimeout !== undefined) out.keepAliveMaxTimeout = agent.keepAliveMaxTimeout;
    if (agent.headersTimeout !== undefined) out.headersTimeout = agent.headersTimeout;
    if (agent.bodyTimeout !== undefined) out.bodyTimeout = agent.bodyTimeout;
    if (agent.connect !== undefined) {
        out.connect = agent.connect as UndiciAgentOptions['connect'];
    }
    return out;
}

/** 用户 signal + 本次尝试超时 → 合并 signal（Node 22+ AbortSignal.any） */
function combineSignals(userSignal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
    const timeoutSignal = timeoutMs != null && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    if (userSignal != null && timeoutSignal != null) return AbortSignal.any([userSignal, timeoutSignal]);
    return userSignal ?? timeoutSignal;
}

/** 可中止的退避等待：用户 abort 立即以 RequestAbortedError 结束 */
function sleepCancellable(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new RequestAbortedError(signal.reason));
    }
    if (ms <= 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        function onAbort(): void {
            clearTimeout(timer);
            reject(new RequestAbortedError(signal?.reason));
        }

        if (signal != null) {
            if (signal.aborted) {
                clearTimeout(timer);
                reject(new RequestAbortedError(signal.reason));
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function cancelBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // 取消失败不影响重试主流程
    }
}

/** 读取响应体并精确截断到上限（HttpError 快照用） */
async function readBodyCapped(response: Response, limitBytes: number): Promise<string> {
    if (response.body == null) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done === true || value == null) break;
            text += decoder.decode(value, { stream: true });
            // 单个 chunk 可能大于剩余预算 → 精确截断到字符数上限
            if (text.length >= limitBytes) {
                text = text.slice(0, limitBytes);
                await reader.cancel().catch(() => {});
                break;
            }
        }
    } catch {
        // 读取失败时返回已读部分
    }
    return text;
}

export function createHttpClient(options?: HttpClientOptions): HttpClient {
    return new HttpClient(options);
}
