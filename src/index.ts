/**
 * undici-http-client
 *
 * 生产级 fetch 风格 HTTP 客户端：
 * Cookie 会话（多实例隔离 + 文件持久化）· 重试退避（含 Retry-After）
 * · 熔断器 · 限流并发 · 遥测统计 · 类型化错误树。
 */
export { HttpClient, createHttpClient } from './client.js';
export { HttpClientRegistry, createHttpClientRegistry } from './registry.js';

export { FileCookieStore } from './file-cookie-store.js';
export {
    exportCookies,
    importCookies,
    createCookieJar,
    flushCookieStore,
} from './cookies.js';
export type { SerializedCookieJar } from './cookies.js';

export {
    ERROR_CODES,
    HttpClientError,
    NetworkError,
    TimeoutError,
    RequestAbortedError,
    CircuitOpenError,
    RateLimitRejectedError,
    HttpError,
    InvalidUrlError,
    isRetryableError,
    normalizeFetchError,
} from './errors.js';

export {
    RETRYABLE_STATUS_CODES,
    IDEMPOTENT_METHODS,
    computeBackoffMs,
    computeRetryDelayMs,
    parseRetryAfterMs,
} from './retry.js';

export { resolveUrl, appendSearchParams } from './url.js';
export { mergeHeaders, normalizeHeaders } from './headers.js';
export type { HeadersLike } from './headers.js';
export { supportsUndiciDispatcher, fetchViaGlobal } from './bun-compat.js';
export type { GlobalFetchCall, GlobalFetchDeps } from './bun-compat.js';

export { CircuitBreaker } from './interceptors/circuit-breaker.js';
export { RequestLimiter } from './interceptors/rate-limit.js';
export { cookieInterceptor } from './interceptors/cookie-interceptor.js';
export { circuitBreakerInterceptor } from './interceptors/circuit-breaker.js';
export { rateLimitInterceptor } from './interceptors/rate-limit.js';

export type {
    AgentOptions,
    CircuitBreakerOptions,
    CookieOptions,
    FetchInit,
    HttpClientOptions,
    Logger,
    RateLimitOptions,
    RetryDecision,
    RetryOptions,
    StatsSnapshot,
    TelemetryEvent,
    TelemetryEventRequestEnd,
    TelemetryEventRequestStart,
    TelemetryEventRetryScheduled,
    TelemetryEventCircuitStateChange,
    TelemetryOptions,
} from './types.js';
export type { CircuitState, CircuitBreakerSnapshot } from './interceptors/circuit-breaker.js';
export type { RequestLimiterSnapshot } from './interceptors/rate-limit.js';
export type { UndiciInterceptor as Interceptor } from './interceptors/utils.js';
