/**
 * 遥测：事件总线 + 内置统计采集 + 日志桥接。
 *
 * 设计（见 DESIGN.md 决策 #6）：
 * - 观测点放在 client 层而非 interceptor 层 —— 这里同时可见
 *   「逻辑结果」（重试后成功/失败、总耗时、attempts）与传输层细节；
 * - 事件为纯数据（结构化、可序列化），监听器异常完全隔离；
 * - StatsSnapshot 为有界内存（1024 环形样本 + 计数器），可长期运行。
 */
import type {
    Logger,
    StatsSnapshot,
    TelemetryEvent,
    TelemetryOptions,
} from './types.js';
import type { CircuitBreakerSnapshot } from './interceptors/circuit-breaker.js';
import type { RequestLimiterSnapshot } from './interceptors/rate-limit.js';

type Listener = (event: TelemetryEvent) => void;

export class TelemetryBus {
    readonly #listeners: Listener[] = [];

    addListener(listener: Listener): () => void {
        this.#listeners.push(listener);
        return () => {
            const index = this.#listeners.indexOf(listener);
            if (index >= 0) this.#listeners.splice(index, 1);
        };
    }

    emit(event: TelemetryEvent): void {
        // 快照遍历：监听器内增删不影响本轮派发
        // （先拷贝再遍历，避免 for-of 直接遍历活数组时
        //   监听器内 splice/新增强干扰本轮派发顺序与完整性）
        const listeners = [...this.#listeners];
        for (const listener of listeners) {
            try {
                listener(event);
            } catch {
                // 监听器故障不得影响请求主流程
            }
        }
    }
}

/* ---------------------- 统计采集 ---------------------- */

const RING_SIZE = 1024;
const EMPTY_DURATION: StatsSnapshot['duration'] = {
    count: 0,
    minMs: 0,
    maxMs: 0,
    p50: 0,
    p95: 0,
    p99: 0,
};

export class StatsCollector {
    #inFlight = 0;
    #totalRequests = 0;
    #totalRetries = 0;
    #totalErrors = 0;
    readonly #statusCounts: StatsSnapshot['statusCounts'] = {
        '1xx': 0,
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
        unknown: 0,
    };
    readonly #ring = new Float64Array(RING_SIZE);
    #ringIndex = 0;
    #ringCount = 0;

    handle(event: TelemetryEvent): void {
        switch (event.type) {
            case 'request:start':
                if (event.attempt === 1) {
                    this.#inFlight += 1;
                    this.#totalRequests += 1;
                } else {
                    this.#totalRetries += 1;
                }
                break;
            case 'request:end':
                this.#inFlight = Math.max(0, this.#inFlight - 1);
                if (event.status != null) {
                    this.#statusCounts[statusClass(event.status)] += 1;
                }
                if (event.error != null) {
                    this.#totalErrors += 1;
                }
                this.#push(event.durationMs);
                break;
            default:
                break;
        }
    }

    snapshot(
        circuitBreaker: CircuitBreakerSnapshot | null,
        rateLimit: RequestLimiterSnapshot | null,
    ): StatsSnapshot {
        return {
            inFlight: this.#inFlight,
            totalRequests: this.#totalRequests,
            totalRetries: this.#totalRetries,
            totalErrors: this.#totalErrors,
            statusCounts: { ...this.#statusCounts },
            duration: this.#durationStats(),
            circuitBreaker,
            rateLimit,
        };
    }

    #push(durationMs: number): void {
        this.#ring[this.#ringIndex] = durationMs;
        this.#ringIndex = (this.#ringIndex + 1) % RING_SIZE;
        this.#ringCount = Math.min(RING_SIZE, this.#ringCount + 1);
    }

    #durationStats(): StatsSnapshot['duration'] {
        if (this.#ringCount === 0) return { ...EMPTY_DURATION };
        const sorted = Array.from(this.#ring.subarray(0, this.#ringCount)).sort((a, b) => a - b);
        return {
            count: sorted.length,
            minMs: sorted[0]!,
            maxMs: sorted[sorted.length - 1]!,
            p50: quantile(sorted, 0.5),
            p95: quantile(sorted, 0.95),
            p99: quantile(sorted, 0.99),
        };
    }
}

function statusClass(status: number): keyof StatsSnapshot['statusCounts'] {
    const century = Math.floor(status / 100);
    switch (century) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
            return `${century}xx` as keyof StatsSnapshot['statusCounts'];
        default:
            return 'unknown';
    }
}

function quantile(sorted: readonly number[], q: number): number {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(q * sorted.length);
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[index]!;
}

/* ---------------------- 日志桥接 ---------------------- */

const LEVEL_WEIGHT: Record<Required<TelemetryOptions>['logLevel'], number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function levelOf(event: TelemetryEvent): keyof typeof LEVEL_WEIGHT {
    switch (event.type) {
        case 'request:end':
            if (event.error != null) return 'error';
            if (event.status != null && event.status >= 500) return 'warn';
            return 'debug';
        case 'retry:scheduled':
            return 'debug';
        case 'circuit-breaker:state-change':
            return 'warn';
        default:
            return 'debug';
    }
}

/**
 * 把遥测事件桥接到任意 Logger 实现（pino/winston/自研均可）。
 * 默认级别 info：常规成功日志(debug)静默，仅告警与错误可见。
 */
export function createLoggerBridge(
    logger: Logger,
    logLevel: Required<TelemetryOptions>['logLevel'] = 'info',
): Listener {
    const threshold = LEVEL_WEIGHT[logLevel];
    return (event) => {
        const level = levelOf(event);
        if (LEVEL_WEIGHT[level] < threshold) return;
        const log = logger[level];
        if (typeof log !== 'function') return;

        if (event.type === 'request:end') {
            log.call(
                logger,
                event.error != null
                    ? `http ${event.method} ${event.url} failed`
                    : `http ${event.method} ${event.url} ${event.status}`,
                {
                    requestId: event.requestId,
                    attempts: event.attempts,
                    durationMs: Math.round(event.durationMs),
                    status: event.status,
                    error: event.error,
                },
            );
        } else if (event.type === 'retry:scheduled') {
            log.call(logger, `http ${event.method} ${event.url} retry scheduled`, {
                requestId: event.requestId,
                nextAttempt: event.nextAttempt,
                delayMs: event.delayMs,
                reason: event.reason,
            });
        } else if (event.type === 'circuit-breaker:state-change') {
            log.call(logger, `circuit breaker ${event.from} -> ${event.to}`, {
                timestamp: new Date(event.timestamp).toISOString(),
            });
        }
    };
}
