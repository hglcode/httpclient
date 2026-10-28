/**
 * 类型化错误树 + undici/fetch 原生错误归一化。
 *
 * 约定：
 * - 所有对外抛出的错误均继承 HttpClientError，携带稳定 `code` 与 `retryable` 元数据；
 * - 保留 `Error.cause` 链，便于排障时看到底层 socket/undici 错误；
 * - `normalizeFetchError` 负责把 undici fetch 抛出的各种原生形态
 *   （TypeError/DOMException/undici Errors/errno）收敛到上述类型树。
 */
import { isRetryableStatus, RETRYABLE_STATUS_CODES } from './retry.js';

export const ERROR_CODES = {
    NETWORK: 'HTTP_CLIENT_NETWORK',
    TIMEOUT: 'HTTP_CLIENT_TIMEOUT',
    ABORTED: 'HTTP_CLIENT_ABORTED',
    CIRCUIT_OPEN: 'HTTP_CLIENT_CIRCUIT_OPEN',
    RATE_LIMIT_REJECTED: 'HTTP_CLIENT_RATE_LIMIT_REJECTED',
    HTTP: 'HTTP_CLIENT_HTTP_ERROR',
    INVALID_URL: 'HTTP_CLIENT_INVALID_URL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export abstract class HttpClientError extends Error {
    /** 稳定错误码，便于日志/告警/switch 分支 */
    readonly code: ErrorCode;
    /** 该错误在默认策略下是否可安全重试 */
    readonly retryable: boolean;

    constructor(
        message: string,
        options: { code: ErrorCode; retryable: boolean; cause?: unknown },
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.code = options.code;
        this.retryable = options.retryable;
    }
}

/** 网络层错误：连接被拒/重置/DNS/断管等 */
export class NetworkError extends HttpClientError {
    constructor(message: string, cause?: unknown) {
        super(message, { code: ERROR_CODES.NETWORK, retryable: true, cause });
    }
}

/** 超时：kind 区分阶段（connect/headers/body/total/queue） */
export class TimeoutError extends HttpClientError {
    readonly kind: 'connect' | 'headers' | 'body' | 'total' | 'queue';

    constructor(
        kind: TimeoutError['kind'],
        message: string,
        cause?: unknown,
    ) {
        super(message, { code: ERROR_CODES.TIMEOUT, retryable: true, cause });
        this.kind = kind;
    }
}

/** 调用方主动中止（AbortSignal）。总是不可重试。 */
export class RequestAbortedError extends HttpClientError {
    /** 触发中止的原因（signal.reason），便于传播用户语义 */
    readonly reason: unknown;

    constructor(reason?: unknown, message = 'Request aborted') {
        super(
            reason instanceof Error ? `${message}: ${reason.message}` : message,
            { code: ERROR_CODES.ABORTED, retryable: false, cause: reason },
        );
        this.reason = reason;
    }
}

/** 熔断器打开，快速失败。总是不可重试。 */
export class CircuitOpenError extends HttpClientError {
    readonly retryInMs: number;
    readonly breakerState: import('./interceptors/circuit-breaker.js').CircuitBreakerSnapshot;

    constructor(
        breakerState: import('./interceptors/circuit-breaker.js').CircuitBreakerSnapshot,
        retryInMs: number,
    ) {
        super(
            `Circuit breaker is open; retry allowed in ${Math.ceil(retryInMs)}ms ` +
                `(failureRate=${(breakerState.failureRate * 100).toFixed(0)}%, ` +
                `volume=${breakerState.volume})`,
            { code: ERROR_CODES.CIRCUIT_OPEN, retryable: false },
        );
        this.retryInMs = retryInMs;
        this.breakerState = breakerState;
    }
}

/** 限流排队被拒：queue-full（队列已满）或 queue-timeout（排队超时） */
export class RateLimitRejectedError extends HttpClientError {
    readonly reason: 'queue-full' | 'queue-timeout';

    constructor(reason: RateLimitRejectedError['reason'], message: string) {
        super(message, { code: ERROR_CODES.RATE_LIMIT_REJECTED, retryable: true });
        this.reason = reason;
    }
}

/** 非 2xx 且开启了 throwOnHttpError 时抛出 */
export class HttpError extends HttpClientError {
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    /** 响应头快照（set-cookie 为数组，其余为逗号拼接字符串） */
    readonly headers: Record<string, string | string[]>;
    /** 响应体快照（最多 64KiB，超出截断） */
    readonly body: string;

    constructor(options: {
        url: string;
        status: number;
        statusText: string;
        headers: Record<string, string | string[]>;
        body: string;
    }) {
        const preview = options.body.length > 200
            ? `${options.body.slice(0, 200)}…(${options.body.length} chars)`
            : options.body;
        super(
            `HTTP ${options.status} ${options.statusText} for ${options.url}: ${preview}`,
            {
                code: ERROR_CODES.HTTP,
                retryable: isRetryableStatus(options.status),
            },
        );
        this.name = 'HttpError';
        this.url = options.url;
        this.status = options.status;
        this.statusText = options.statusText;
        this.headers = options.headers;
        this.body = options.body;
    }
}

/** URL 解析/拼接失败 */
export class InvalidUrlError extends HttpClientError {
    constructor(message: string, cause?: unknown) {
        super(message, { code: ERROR_CODES.INVALID_URL, retryable: false, cause });
    }
}

export function isRetryableError(error: unknown): error is HttpClientError {
    return error instanceof HttpClientError && error.retryable;
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

const ABORT_MARKERS: ReadonlySet<string> = new Set([
    'RequestAbortedError',
    'UND_ERR_ABORTED',
    'AbortError',
]);

const NETWORK_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPROTO',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_CLOSED_SOCKET', // 兼容旧版本命名
    'UND_ERR_DESTROYED',
]);

function markersOf(value: unknown): string[] {
    if (value == null || typeof value !== 'object') return [];
    const err = value as { name?: unknown; code?: unknown };
    const markers: string[] = [];
    if (typeof err.name === 'string' && err.name) markers.push(err.name);
    if (typeof err.code === 'string' && err.code) markers.push(err.code);
    return markers;
}

function isTimeoutDomException(reason: unknown): boolean {
    return (
        reason != null &&
        typeof reason === 'object' &&
        (reason as { name?: unknown }).name === 'TimeoutError'
    );
}

/**
 * 将 undici fetch 抛出的任意错误收敛为类型树成员。
 *
 * 判定优先级：
 * 1. 已是 HttpClientError → 原样返回；
 * 2. undici fetch 按 spec 将网络错误包装为 TypeError('fetch failed', {cause})
 *    —— 先沿 cause 链解包我们自己的类型化错误（熔断/限流等）；
 * 3. 合并 signal 已触发 → 按 reason 区分 TimeoutError / RequestAbortedError；
 * 4. 沿 cause 链寻找超时/网络标记；
 * 5. 兜底 NetworkError（保留 cause）。
 */
export function normalizeFetchError(
    error: unknown,
    context: { url: string; method: string; signal?: AbortSignal; timeoutMs?: number },
): HttpClientError {
    if (error instanceof HttpClientError) return error;

    // undici fetch 的 spec 包装：TypeError('fetch failed', { cause }) —— 解包内层
    const unwrapped = findHttpClientError(error);
    if (unwrapped != null) return unwrapped;

    const describe = (fallback: string): string => {
        const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return base || fallback;
    };

    // 1. signal 已中止：AbortSignal.any 会传播首个触发源的 reason
    if (context.signal?.aborted) {
        const reason: unknown = context.signal.reason;
        if (isTimeoutDomException(reason)) {
            return new TimeoutError(
                'total',
                `Request timed out after ${context.timeoutMs ?? 'unknown'}ms`,
                error,
            );
        }
        return new RequestAbortedError(reason, 'Request aborted');
    }

    // 2. AbortSignal.timeout 触发时，fetch 按 spec 直接以该 DOMException reject
    if (isTimeoutDomException(error)) {
        return new TimeoutError('total', `Request timed out after ${context.timeoutMs ?? 'unknown'}ms`, error);
    }

    // 3. 沿 cause 链（最多 5 层）找确定性标记
    let cursor: unknown = error;
    for (let depth = 0; depth < 5 && cursor != null; depth++, cursor = (cursor as { cause?: unknown }).cause) {
        for (const marker of markersOf(cursor)) {
            if (marker === 'HeadersTimeoutError' || marker === 'UND_ERR_HEADERS_TIMEOUT') {
                return new TimeoutError('headers', 'Timed out waiting for response headers', error);
            }
            if (marker === 'BodyTimeoutError' || marker === 'UND_ERR_BODY_TIMEOUT') {
                return new TimeoutError('body', 'Timed out waiting for response body', error);
            }
            if (marker === 'ConnectTimeoutError' || marker === 'UND_ERR_CONNECT_TIMEOUT') {
                return new TimeoutError('connect', 'Timed out while establishing connection', error);
            }
            if (NETWORK_CODES.has(marker)) {
                return new NetworkError(describe('Network request failed'), error);
            }
            if (ABORT_MARKERS.has(marker)) {
                // 到这里 signal 未中止，说明是 undici 内部中止（如 keep-alive 竞态）→ 视为网络错误更安全
                return new NetworkError(describe('Request aborted at transport level'), error);
            }
        }
    }

    // 4. fetch 规范：网络失败统一抛 TypeError
    return new NetworkError(describe('Network request failed'), error);
}

/** 在 cause 链中寻找被 fetch 包装吞掉的类型化错误（如 CircuitOpenError） */
function findHttpClientError(error: unknown, depth = 0): HttpClientError | null {
    let cursor: unknown = error;
    for (let i = 0; i < depth + 5 && cursor != null; i++, cursor = (cursor as { cause?: unknown }).cause) {
        if (cursor instanceof HttpClientError) return cursor;
    }
    return null;
}

export { RETRYABLE_STATUS_CODES };
