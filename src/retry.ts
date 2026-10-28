/**
 * 重试策略：退避计算、Retry-After 解析、可重放 body 判定。
 *
 * 放在 client 层（而非 undici interceptor）的原因见 DESIGN.md 决策 #2：
 * undici fetch 会把 body 转为流，dispatcher 层无法安全重放；
 * client 层持有原始 body 值，可精确控制重放与语义（Retry-After / jitter /
 * 幂等方法白名单）。
 */
import type { RetryOptions } from './types.js';

export const RETRYABLE_STATUS_CODES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];
const RETRYABLE_STATUS_SET: ReadonlySet<number> = new Set(RETRYABLE_STATUS_CODES);

export const IDEMPOTENT_METHODS: readonly string[] = [
    'GET',
    'HEAD',
    'OPTIONS',
    'TRACE',
    'PUT',
    'DELETE',
];

export interface ResolvedRetryOptions {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffFactor: number;
    jitter: 'none' | 'full' | 'half';
    retryOnStatus: ReadonlySet<number>;
    methods: ReadonlySet<string>;
    respectRetryAfter: boolean;
    canRetry?: (decision: import('./types.js').RetryDecision) => boolean;
}

export const DEFAULT_RETRY: Readonly<
    Omit<ResolvedRetryOptions, 'retryOnStatus' | 'methods' | 'canRetry'>
> = Object.freeze({
    maxRetries: 2,
    initialDelayMs: 200,
    maxDelayMs: 30_000,
    backoffFactor: 2,
    jitter: 'half',
    respectRetryAfter: true,
});

function toSet<T>(values: readonly T[] | undefined, fallback: readonly T[]): ReadonlySet<T> {
    return new Set(values ?? fallback);
}

function defaultResolved(): ResolvedRetryOptions {
    return {
        ...DEFAULT_RETRY,
        retryOnStatus: new Set(RETRYABLE_STATUS_CODES),
        methods: new Set(IDEMPOTENT_METHODS),
    };
}

/** 合并用户配置与默认值（用于构造器与 per-request 覆盖） */
export function resolveRetryOptions(
    options: RetryOptions | false | undefined,
    base?: ResolvedRetryOptions | null,
): ResolvedRetryOptions | null {
    if (options === false) return null;
    if (options === undefined) {
        // 尊重 client 层配置：显式禁用（null）必须保持禁用，不得回退默认值
        if (base !== undefined) return base;
        return defaultResolved();
    }
    const src = base ?? defaultResolved();
    return {
        maxRetries: options.maxRetries ?? src.maxRetries,
        initialDelayMs: options.initialDelayMs ?? src.initialDelayMs,
        maxDelayMs: options.maxDelayMs ?? src.maxDelayMs,
        backoffFactor: options.backoffFactor ?? src.backoffFactor,
        jitter: options.jitter ?? src.jitter,
        retryOnStatus: toSet(options.retryOnStatus, [...src.retryOnStatus]),
        methods: toSet(options.methods, [...src.methods]),
        respectRetryAfter: options.respectRetryAfter ?? src.respectRetryAfter,
        canRetry: options.canRetry ?? src.canRetry,
    };
}

export function isRetryableStatus(status: number, options?: ResolvedRetryOptions | null): boolean {
    const set = options?.retryOnStatus ?? RETRYABLE_STATUS_SET;
    return set.has(status);
}

export function isMethodRetryable(
    method: string,
    options: ResolvedRetryOptions | null,
): boolean {
    if (options == null) return false;
    return options.methods.has(method.toUpperCase());
}

/**
 * 判断 body 是否可安全重放（原始值仍持有、未流式化）。
 * ReadableStream / Node Readable / AsyncIterable 只能消费一次 → 不可重放。
 */
export function isBodyReplayable(body: unknown): boolean {
    if (body == null) return true;
    if (typeof body === 'string' || body instanceof ArrayBuffer) return true;
    if (ArrayBuffer.isView(body)) return true;
    if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
    if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
    return false; // Readable / ReadableStream / AsyncIterable / 未知类型
}

/**
 * 指数退避 + 抖动。
 * @param nextAttempt 即将开始的尝试序号（2 = 第一次重试）
 */
export function computeBackoffMs(nextAttempt: number, options: ResolvedRetryOptions): number {
    const exponent = Math.max(0, nextAttempt - 2);
    let delay = options.initialDelayMs * Math.pow(options.backoffFactor, exponent);
    if (!Number.isFinite(delay) || delay <= 0) delay = options.initialDelayMs;
    delay = Math.min(delay, options.maxDelayMs);

    switch (options.jitter) {
        case 'none':
            return Math.round(delay);
        case 'full':
            return Math.round(Math.random() * delay);
        case 'half':
        default:
            // half-jitter：[delay/2, delay) —— 保留退避趋势的同时打散并发重试
            return Math.round(delay / 2 + (Math.random() * delay) / 2);
    }
}

/**
 * 解析 Retry-After 头（秒数或 HTTP-date）为毫秒。
 * 返回 null 表示缺失或不可解析（沿用常规退避）。
 * 负值截断为 0（服务器时钟偏差容忍）。
 */
export function parseRetryAfterMs(
    value: string | null,
    now: number = Date.now(),
): number | null {
    if (value == null || value.trim() === '') return null;
    const trimmed = value.trim();

    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed) * 1000;
    }

    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
        return Math.max(0, asDate - now);
    }

    return null;
}

/**
 * 计算最终重试等待：优先 Retry-After（可配置关闭），
 * 其次退避；Retry-After 超过 maxDelayMs 时截断（避免无限等待）。
 */
export function computeRetryDelayMs(
    nextAttempt: number,
    options: ResolvedRetryOptions,
    retryAfterHeader: string | null,
    now: number = Date.now(),
): number {
    if (options.respectRetryAfter && retryAfterHeader != null) {
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
        if (retryAfterMs != null) {
            return Math.min(Math.max(retryAfterMs, 0), Math.max(options.maxDelayMs, options.initialDelayMs));
        }
    }
    return computeBackoffMs(nextAttempt, options);
}
