/**
 * 公共类型定义。
 *
 * 设计原则：
 * - fetch 风格：对外只暴露一个 `fetch(input, init)`，init 扩展自 undici 的 RequestInit；
 * - 所有可选项均在构造器给默认值，per-request 只做覆盖；
 * - `false` 表示显式关闭某能力（如 `retry: false`）。
 */
import type { RequestInit as UndiciRequestInit, HeadersInit } from 'undici';
import type { Store } from 'tough-cookie';
import type { CircuitState, CircuitBreakerSnapshot } from './interceptors/circuit-breaker.js';
import type { RequestLimiterSnapshot } from './interceptors/rate-limit.js';

/** 最小日志接口（pino / winston / 自研 logger 均可桥接，未提供时静默） */
export interface Logger {
    debug?(message: string, context?: object): void;
    info?(message: string, context?: object): void;
    warn?(message: string, context?: object): void;
    error?(message: string, context?: object): void;
}

/** 重试策略（client 层实现，见 DESIGN.md 决策 #2） */
export interface RetryOptions {
    /** 最大重试次数（不含首次请求）。0 = 只请求一次。默认 2 */
    maxRetries?: number;
    /** 首次退避毫秒数。默认 200 */
    initialDelayMs?: number;
    /** 退避上限毫秒数。默认 30_000 */
    maxDelayMs?: number;
    /** 指数因子。默认 2 */
    backoffFactor?: number;
    /** 抖动策略：none / full（0~delay 均匀）/ half（delay/2 + random*delay/2）。默认 half */
    jitter?: 'none' | 'full' | 'half';
    /** 触发重试的状态码。默认 [408, 425, 429, 500, 502, 503, 504] */
    retryOnStatus?: readonly number[];
    /** 允许重试的 HTTP 方法（幂等方法）。默认 ['GET','HEAD','OPTIONS','TRACE','PUT','DELETE'] */
    methods?: readonly string[];
    /** 是否遵循 Retry-After 响应头（秒数或 HTTP-date），并以上限截断。默认 true */
    respectRetryAfter?: boolean;
    /**
     * 自定义重试裁决钩子。返回 false 阻止本次重试。
     * 在所有内置条件（状态码/方法/次数/可重放 body）都满足后才调用。
     */
    canRetry?: (decision: RetryDecision) => boolean;
}

export interface RetryDecision {
    url: string;
    method: string;
    /** 即将开始的尝试序号（2 = 第一次重试） */
    nextAttempt: number;
    /** 基于响应触发时存在 */
    status?: number;
    /** 基于异常触发时存在 */
    error?: import('./errors.js').HttpClientError;
    /** 计算好的退避等待毫秒数（已含抖动与 Retry-After） */
    delayMs: number;
}

/** 熔断器（undici interceptor 层实现，按"实际发出的请求"统计） */
export interface CircuitBreakerOptions {
    /** 滑动窗口时长 ms。默认 10_000 */
    windowDurationMs?: number;
    /** 滑动窗口分桶数。默认 10 */
    buckets?: number;
    /** 窗口内最小请求量，未达阈值不评估失败率。默认 10 */
    minimumVolume?: number;
    /** 失败率阈值（0~1），达到即熔断。默认 0.5 */
    failureRateThreshold?: number;
    /** 熔断保持时长 ms，之后进入半开。默认 30_000 */
    openDurationMs?: number;
    /** 半开状态允许的探测请求数。默认 5 */
    halfOpenMaxProbes?: number;
    /** 半开探测中成功多少个即恢复闭合。默认 3 */
    halfOpenSuccessThreshold?: number;
    /** 计入熔断失败的响应状态码。默认 [500, 502, 503, 504]（传输错误总是计入） */
    failureStatusCodes?: readonly number[];
}

/** 限流 / 并发控制（undici interceptor 层实现） */
export interface RateLimitOptions {
    /** 单 client 最大并发请求数（超出则排队）。默认 Infinity（不限制） */
    maxConcurrent?: number;
    /** 排队长度上限，超出立即以 RateLimitRejectedError 失败。0 = 不限。默认 0 */
    queueLimit?: number;
    /** 单个请求在队列中的最长等待 ms，超出以 RateLimitRejectedError 失败。默认 60_000 */
    queueTimeoutMs?: number;
    /** 每秒请求数上限（令牌桶）。默认 Infinity（不限制） */
    requestsPerSecond?: number;
    /** 令牌桶容量（允许的突发量）。默认取 ceil(requestsPerSecond) */
    burst?: number;
}

/** undici Agent 连接池调优（透传子集） */
export interface AgentOptions {
    /** 每个源的最大连接数。默认 null（不限） */
    connections?: number | null;
    /** 每连接 pipeline 深度。默认 1 */
    pipelining?: number;
    /** 空闲连接保活时长 ms。默认 4_000 */
    keepAliveTimeout?: number;
    keepAliveMaxTimeout?: number;
    /** 响应头超时 ms。默认 300_000 */
    headersTimeout?: number;
    /** 响应体两次数据之间的超时 ms。默认 300_000 */
    bodyTimeout?: number;
    /** 传给 net/tls.connect 的其他选项（如 rejectUnauthorized） */
    connect?: Record<string, unknown>;
}

/** Cookie 会话配置 */
export interface CookieOptions {
    /** 自定义 tough-cookie Store（内存 / Redis / 自研均可）。默认 MemoryCookieStore */
    store?: Store;
    /** 文件持久化目录（配合 FileCookieStore，close() 时优雅落盘） */
    dir?: string;
    /** 持久化文件前缀，最终文件名 `${prefix}-${sha256(baseURL).slice(0,16)}.json`。默认 'cookies' */
    filePrefix?: string;
    /** 落盘去抖动 ms。默认 500 */
    persistDebounceMs?: number;
}

export interface TelemetryEventRequestStart {
    type: 'request:start';
    requestId: string;
    method: string;
    url: string;
    attempt: number;
    timestamp: number;
}

export interface TelemetryEventRequestEnd {
    type: 'request:end';
    requestId: string;
    method: string;
    url: string;
    /** 总尝试次数（含重试） */
    attempts: number;
    status?: number;
    durationMs: number;
    error?: { name: string; code: string; message: string };
    timestamp: number;
}

export interface TelemetryEventRetryScheduled {
    type: 'retry:scheduled';
    requestId: string;
    method: string;
    url: string;
    nextAttempt: number;
    delayMs: number;
    reason: string;
    timestamp: number;
}

export interface TelemetryEventCircuitStateChange {
    type: 'circuit-breaker:state-change';
    from: CircuitState;
    to: CircuitState;
    timestamp: number;
}

export type TelemetryEvent =
    | TelemetryEventRequestStart
    | TelemetryEventRequestEnd
    | TelemetryEventRetryScheduled
    | TelemetryEventCircuitStateChange;

export interface TelemetryOptions {
    /** 订阅遥测事件（结构化、低开销，可桥接任意 APM） */
    onEvent?: (event: TelemetryEvent) => void;
    /** 注入日志实现。默认 false（完全静默，生产安全） */
    logger?: Logger | false;
    /** 日志最低级别。默认 'info' */
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    /** 是否内置采集统计（client.stats）。默认 true */
    collectStats?: boolean;
}

/** HTTPClient 构造选项 */
export interface HttpClientOptions {
    /** 基础 URL，相对路径会与之拼接（构造期校验，尽早失败） */
    baseURL?: string;
    /** 默认请求头（每次请求可覆盖同名头） */
    headers?: HeadersInit | Record<string, string>;
    /** 默认总超时 ms（每次请求可覆盖） */
    timeout?: number;
    /** 重试策略；false 关闭。默认启用（maxRetries=2） */
    retry?: RetryOptions | false;
    /** 熔断器；false 关闭。默认启用（默认参数） */
    circuitBreaker?: CircuitBreakerOptions | false;
    /** 限流并发；false 关闭。默认关闭（避免隐式行为） */
    rateLimit?: RateLimitOptions | false;
    /** Cookie 会话；false 关闭（完全无 cookie）。默认内存 jar */
    cookies?: CookieOptions | false;
    /** 遥测 / 日志 */
    telemetry?: TelemetryOptions;
    /** undici Agent 连接池调优 */
    agent?: AgentOptions;
    /** 非 2xx 时抛 HttpError。默认 false（遵循 fetch 语义，返回 Response 由调用方判断） */
    throwOnHttpError?: boolean;
}

/** per-request init：扩展 undici RequestInit */
export interface FetchInit extends Omit<UndiciRequestInit, 'headers' | 'signal' | 'dispatcher'> {
    headers?: HeadersInit;
    signal?: AbortSignal;
    /** 本请求总超时 ms，覆盖构造器默认 */
    timeout?: number;
    /** 覆盖构造器重试配置；false 关闭本请求重试 */
    retry?: RetryOptions | false;
    /** 覆盖 throwOnHttpError */
    throwOnHttpError?: boolean;
    /** JSON 便捷写法：JSON.stringify 后作为 body，并自动补 content-type: application/json */
    json?: unknown;
    /** 查询参数快捷方式（对象 / URLSearchParams / 'a=1&b=2'） */
    searchParams?: URLSearchParams | Record<string, string | number | boolean> | string;
}

export interface StatsSnapshot {
    /** 进行中的请求数（含排队） */
    inFlight: number;
    totalRequests: number;
    /** 重试总次数（attempts - requests） */
    totalRetries: number;
    totalErrors: number;
    statusCounts: Record<'1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'unknown', number>;
    duration: {
        count: number;
        minMs: number;
        maxMs: number;
        p50: number;
        p95: number;
        p99: number;
    };
    circuitBreaker: CircuitBreakerSnapshot | null;
    rateLimit: RequestLimiterSnapshot | null;
}
