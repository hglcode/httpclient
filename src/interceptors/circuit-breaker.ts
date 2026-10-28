/**
 * 熔断器：滑动窗口失败率统计 + closed/open/half-open 三态机，
 * 以 undici interceptor 形式落在 dispatcher 链上（决策见 DESIGN.md 决策 #4）。
 *
 * 统计口径：**实际发出的请求**（到达本层的 dispatch）。
 * - 传输错误（onResponseError）→ 失败；
 * - 命中 failureStatusCodes 的响应 → 失败（默认 500/502/503/504）；
 * - 其余响应 → 成功；4xx 视为业务语义，不计失败；
 * - 调用方主动中止同样计入失败（与 opossum 一致，保守保护下游）。
 */
import { CircuitOpenError } from '../errors.js';
import type { CircuitBreakerOptions } from '../types.js';
import type { DispatchController, DispatchHandler, UndiciInterceptor } from './utils.js';
import { BaseDispatchHandler, rejectAsync } from './utils.js';

type HeadersLike = Record<string, string | string[] | undefined>;

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerSnapshot {
    state: CircuitState;
    /** 滑动窗口内样本量 */
    volume: number;
    /** 滑动窗口内失败数 */
    failures: number;
    /** 滑动窗口内失败率（volume=0 时为 0） */
    failureRate: number;
    /** open 状态：距打开过了多久 */
    openedAgoMs: number | null;
    /** open 状态：距进入 half-open 还需多久 */
    retryInMs: number | null;
}

export interface ResolvedCircuitBreakerOptions {
    windowDurationMs: number;
    buckets: number;
    minimumVolume: number;
    failureRateThreshold: number;
    openDurationMs: number;
    halfOpenMaxProbes: number;
    halfOpenSuccessThreshold: number;
    failureStatusCodes: ReadonlySet<number>;
}

export const DEFAULT_CIRCUIT_BREAKER: Readonly<
    Omit<ResolvedCircuitBreakerOptions, 'failureStatusCodes'>
> = Object.freeze({
    windowDurationMs: 10_000,
    buckets: 10,
    minimumVolume: 10,
    failureRateThreshold: 0.5,
    openDurationMs: 30_000,
    halfOpenMaxProbes: 5,
    halfOpenSuccessThreshold: 3,
});

export const DEFAULT_FAILURE_STATUS_CODES: readonly number[] = [500, 502, 503, 504];

export function resolveCircuitBreakerOptions(
    options?: CircuitBreakerOptions | false,
): ResolvedCircuitBreakerOptions | null {
    if (options === false || options === undefined) {
        return options === false
            ? null
            : {
                  ...DEFAULT_CIRCUIT_BREAKER,
                  failureStatusCodes: new Set(DEFAULT_FAILURE_STATUS_CODES),
              };
    }
    return {
        windowDurationMs: options.windowDurationMs ?? DEFAULT_CIRCUIT_BREAKER.windowDurationMs,
        buckets: Math.max(1, options.buckets ?? DEFAULT_CIRCUIT_BREAKER.buckets),
        minimumVolume: options.minimumVolume ?? DEFAULT_CIRCUIT_BREAKER.minimumVolume,
        failureRateThreshold:
            options.failureRateThreshold ?? DEFAULT_CIRCUIT_BREAKER.failureRateThreshold,
        openDurationMs: options.openDurationMs ?? DEFAULT_CIRCUIT_BREAKER.openDurationMs,
        halfOpenMaxProbes: options.halfOpenMaxProbes ?? DEFAULT_CIRCUIT_BREAKER.halfOpenMaxProbes,
        halfOpenSuccessThreshold:
            options.halfOpenSuccessThreshold ?? DEFAULT_CIRCUIT_BREAKER.halfOpenSuccessThreshold,
        failureStatusCodes: new Set(options.failureStatusCodes ?? DEFAULT_FAILURE_STATUS_CODES),
    };
}

interface Bucket {
    slot: number;
    total: number;
    failures: number;
}

export type CircuitAdmission =
    | { allowed: true; probe: boolean }
    | { allowed: false; retryInMs: number };

/** 纯状态机，与传输层解耦，可独立单测 */
export class CircuitBreaker {
    readonly #options: ResolvedCircuitBreakerOptions;
    readonly #bucketData: Bucket[];
    readonly #bucketMs: number;

    #state: CircuitState = 'closed';
    #openedAt = 0;
    #halfOpenActive = 0;
    #halfOpenSuccesses = 0;
    #halfOpenCompleted = 0;

    /** 状态变更回调（client 用于遥测事件），构造后赋值 */
    onStateChange?: (from: CircuitState, to: CircuitState) => void;

    constructor(options: ResolvedCircuitBreakerOptions) {
        this.#options = options;
        this.#bucketMs = options.windowDurationMs / options.buckets;
        this.#bucketData = Array.from({ length: options.buckets }, () => ({
            slot: -1,
            total: 0,
            failures: 0,
        }));
    }

    get state(): CircuitState {
        return this.snapshot().state;
    }

    /** 请求准入。open 期间快速失败；到期进入 half-open 并放行有限探测 */
    beforeRequest(now: number = Date.now()): CircuitAdmission {
        if (this.#state === 'open' && now - this.#openedAt >= this.#options.openDurationMs) {
            this.#transition('half-open', now);
        }

        switch (this.#state) {
            case 'closed':
                return { allowed: true, probe: false };
            case 'open':
                return {
                    allowed: false,
                    retryInMs: Math.max(
                        0,
                        this.#options.openDurationMs - (now - this.#openedAt),
                    ),
                };
            case 'half-open': {
                if (this.#halfOpenActive < this.#options.halfOpenMaxProbes) {
                    this.#halfOpenActive += 1;
                    return { allowed: true, probe: true };
                }
                // 探测名额已满：在途探测很快会给出结论，给一个温和的回看间隔
                return {
                    allowed: false,
                    retryInMs: Math.min(
                        5_000,
                        Math.max(100, this.#options.openDurationMs / 4),
                    ),
                };
            }
        }
    }

    onSuccess(probe: boolean, now: number = Date.now()): void {
        if (probe) {
            this.#halfOpenActive = Math.max(0, this.#halfOpenActive - 1);
            this.#halfOpenSuccesses += 1;
            this.#halfOpenCompleted += 1;
            this.#evaluateHalfOpen(now);
        } else {
            this.#record(now, false);
            // 成功同样降低失败率 —— 每次采样后都评估（与 resilience4j 一致）
            this.#maybeTrip(now);
        }
    }

    onFailure(probe: boolean, now: number = Date.now()): void {
        if (probe) {
            this.#halfOpenActive = Math.max(0, this.#halfOpenActive - 1);
            this.#halfOpenCompleted += 1;
            const remaining = this.#options.halfOpenMaxProbes - this.#halfOpenCompleted;
            // 剩余探测已不可能凑够成功阈值 → 立即重新熔断（不浪费探测名额）
            if (this.#halfOpenSuccesses + Math.max(0, remaining) < this.#options.halfOpenSuccessThreshold) {
                this.#transition('open', now);
            } else {
                this.#evaluateHalfOpen(now);
            }
        } else {
            this.#record(now, true);
            this.#maybeTrip(now);
        }
    }

    #evaluateHalfOpen(now: number): void {
        // 达到成功阈值即可提前恢复（更快放开流量，无需等满全部探测）
        if (
            this.#halfOpenSuccesses >= this.#options.halfOpenSuccessThreshold ||
            this.#halfOpenCompleted >= this.#options.halfOpenMaxProbes
        ) {
            if (this.#halfOpenSuccesses >= this.#options.halfOpenSuccessThreshold) {
                this.#transition('closed', now);
            } else {
                this.#transition('open', now);
            }
        }
    }

    #maybeTrip(now: number): void {
        if (this.#state !== 'closed') return;
        const { total, failures } = this.#windowStats(now);
        if (
            total >= this.#options.minimumVolume &&
            failures / total >= this.#options.failureRateThreshold
        ) {
            this.#transition('open', now);
        }
    }

    #record(now: number, failed: boolean): void {
        const slot = Math.floor(now / this.#bucketMs);
        const bucket = this.#bucketData[slot % this.#bucketData.length]!;
        if (bucket.slot !== slot) {
            bucket.slot = slot;
            bucket.total = 0;
            bucket.failures = 0;
        }
        bucket.total += 1;
        if (failed) bucket.failures += 1;
    }

    #windowStats(now: number): { total: number; failures: number } {
        const minSlot = Math.floor((now - this.#options.windowDurationMs) / this.#bucketMs);
        let total = 0;
        let failures = 0;
        for (const bucket of this.#bucketData) {
            if (bucket.slot >= minSlot) {
                total += bucket.total;
                failures += bucket.failures;
            }
        }
        return { total, failures };
    }

    #transition(to: CircuitState, now: number): void {
        const from = this.#state;
        if (from === to) return;
        this.#state = to;
        if (to === 'open' || to === 'half-open') {
            this.#openedAt = now;
            this.#halfOpenActive = 0;
            this.#halfOpenSuccesses = 0;
            this.#halfOpenCompleted = 0;
        }
        if (to === 'closed') {
            // 恢复时清空窗口：历史失败不应在刚恢复时立刻再次熔断
            for (const bucket of this.#bucketData) {
                bucket.slot = -1;
                bucket.total = 0;
                bucket.failures = 0;
            }
        }
        this.onStateChange?.(from, to);
    }

    /** 状态快照（含 open→half-open 的惰性转移，便于观测） */
    snapshot(now: number = Date.now()): CircuitBreakerSnapshot {
        if (
            this.#state === 'open' &&
            now - this.#openedAt >= this.#options.openDurationMs
        ) {
            this.#transition('half-open', now);
        }
        const { total, failures } = this.#windowStats(now);
        const inOpenState = this.#state === 'open';
        return {
            state: this.#state,
            volume: total,
            failures,
            failureRate: total > 0 ? failures / total : 0,
            openedAgoMs: inOpenState ? now - this.#openedAt : null,
            retryInMs: inOpenState
                ? Math.max(0, this.#options.openDurationMs - (now - this.#openedAt))
                : null,
        };
    }
}

/* ---------------------- undici interceptor ---------------------- */

/** 响应侧观察者：按结果向熔断器记账（成功 / 失败 / 传输错误） */
class CircuitBreakerHandler extends BaseDispatchHandler {
    readonly #breaker: CircuitBreaker;
    readonly #probe: boolean;
    readonly #failureStatusCodes: ReadonlySet<number>;
    #settled = false;
    #responseFailed = false;

    constructor(
        breaker: CircuitBreaker,
        probe: boolean,
        failureStatusCodes: ReadonlySet<number>,
        handler: DispatchHandler,
    ) {
        super(handler);
        this.#breaker = breaker;
        this.#probe = probe;
        this.#failureStatusCodes = failureStatusCodes;
    }

    override onResponseStart(
        controller: DispatchController,
        statusCode: number,
        headers: HeadersLike,
        statusMessage: string | undefined,
    ): boolean | void {
        this.#responseFailed = this.#failureStatusCodes.has(statusCode);
        return super.onResponseStart(controller, statusCode, headers, statusMessage);
    }

    override onResponseEnd(
        controller: DispatchController,
        trailers: HeadersLike,
    ): void {
        this.#settle(!this.#responseFailed);
        return super.onResponseEnd(controller, trailers);
    }

    override onResponseError(
        controller: DispatchController,
        error: Error,
    ): void {
        this.#settle(false);
        return super.onResponseError(controller, error);
    }

    #settle(success: boolean): void {
        if (this.#settled) return;
        this.#settled = true;
        if (success) this.#breaker.onSuccess(this.#probe);
        else this.#breaker.onFailure(this.#probe);
    }
}

/**
 * 创建熔断拦截器。
 * 组合位置：位于限流之内、cookie 之外 ——
 * 只统计真正到达网络的请求；限流拒绝不污染熔断统计。
 */
export function circuitBreakerInterceptor(
    breaker: CircuitBreaker,
    failureStatusCodes: ReadonlySet<number>,
): UndiciInterceptor {
    return (dispatch) => (opts, handler) => {
        const admission = breaker.beforeRequest();
        if (!admission.allowed) {
            rejectAsync(handler, new CircuitOpenError(breaker.snapshot(), admission.retryInMs));
            return true;
        }
        return dispatch(
            opts,
            new CircuitBreakerHandler(breaker, admission.probe, failureStatusCodes, handler),
        );
    };
}
