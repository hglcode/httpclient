import { describe, expect, it, vi } from 'vitest';
import { StatsCollector, TelemetryBus, createLoggerBridge } from '../../src/telemetry.js';
import type { TelemetryEvent, TelemetryEventRequestEnd, TelemetryEventRequestStart, Logger } from '../../src/types.js';

function startEvent(attempt: number): TelemetryEventRequestStart {
    return { type: 'request:start', requestId: 'r1', method: 'GET', url: 'https://a.com', attempt, timestamp: 0 };
}

function endEvent(overrides: Partial<TelemetryEventRequestEnd> = {}): TelemetryEventRequestEnd {
    return {
        type: 'request:end',
        requestId: 'r1',
        method: 'GET',
        url: 'https://a.com',
        attempts: 1,
        durationMs: 100,
        timestamp: 0,
        ...overrides,
    };
}

describe('StatsCollector', () => {
    it('请求数 / 重试数 / inFlight 计数', () => {
        const stats = new StatsCollector();
        stats.handle(startEvent(1)); // 请求开始
        stats.handle(startEvent(2)); // 重试
        stats.handle(startEvent(3)); // 重试
        stats.handle(endEvent({ attempts: 3 }));
        const snap = stats.snapshot(null, null);
        expect(snap.totalRequests).toBe(1);
        expect(snap.totalRetries).toBe(2);
        expect(snap.inFlight).toBe(0);
    });

    it('并发 inFlight 跟踪', () => {
        const stats = new StatsCollector();
        stats.handle({ ...startEvent(1), requestId: 'a' });
        stats.handle({ ...startEvent(1), requestId: 'b' });
        expect(stats.snapshot(null, null).inFlight).toBe(2);
        stats.handle({ ...endEvent(), requestId: 'a' });
        expect(stats.snapshot(null, null).inFlight).toBe(1);
    });

    it('状态码分类与错误计数', () => {
        const stats = new StatsCollector();
        stats.handle(startEvent(1));
        stats.handle(endEvent({ status: 200 }));
        stats.handle(startEvent(1));
        stats.handle(endEvent({ status: 503 }));
        stats.handle(startEvent(1));
        stats.handle(endEvent({ status: 99 })); // 非常规状态码 → unknown
        stats.handle(startEvent(1));
        stats.handle(endEvent({ error: { name: 'NetworkError', code: 'HTTP_CLIENT_NETWORK', message: 'x' } }));
        const snap = stats.snapshot(null, null);
        expect(snap.statusCounts['2xx']).toBe(1);
        expect(snap.statusCounts['5xx']).toBe(1);
        expect(snap.statusCounts.unknown).toBe(1);
        expect(snap.totalErrors).toBe(1);
    });

    it('耗时直方图分位数（环形缓冲精确计算）', () => {
        const stats = new StatsCollector();
        const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        for (const [i, d] of durations.entries()) {
            stats.handle({ ...startEvent(1), requestId: `r${i}` });
            stats.handle({ ...endEvent(), requestId: `r${i}`, durationMs: d });
        }
        const { duration } = stats.snapshot(null, null);
        expect(duration.count).toBe(10);
        expect(duration.minMs).toBe(10);
        expect(duration.maxMs).toBe(100);
        expect(duration.p50).toBe(50);
        expect(duration.p95).toBe(100);
        expect(duration.p99).toBe(100);
    });

    it('超过环形容量后保留最近样本', () => {
        const stats = new StatsCollector();
        for (let i = 1; i <= 1100; i++) {
            stats.handle({ ...startEvent(1), requestId: `r${i}` });
            stats.handle({ ...endEvent(), requestId: `r${i}`, durationMs: i });
        }
        const { duration } = stats.snapshot(null, null);
        expect(duration.count).toBe(1024);
        expect(duration.minMs).toBe(77); // 1101-1024=77
    });
});

describe('TelemetryBus', () => {
    it('监听器异常被隔离，不影响其他监听器', () => {
        const bus = new TelemetryBus();
        const ok = vi.fn();
        bus.addListener(() => {
            throw new Error('listener boom');
        });
        bus.addListener(ok);
        expect(() => bus.emit(endEvent())).not.toThrow();
        expect(ok).toHaveBeenCalledTimes(1);
    });

    it('addListener 返回退订函数', () => {
        const bus = new TelemetryBus();
        const fn = vi.fn();
        const off = bus.addListener(fn);
        off();
        bus.emit(endEvent());
        expect(fn).not.toHaveBeenCalled();
    });

    it('快照派发：监听器内退订自身/新增监听器不影响本轮派发', () => {
        const bus = new TelemetryBus();
        const calls: string[] = [];
        const late = vi.fn(() => calls.push('late'));
        let added = false;

        bus.addListener(() => {
            calls.push('first');
            if (!added) {
                added = true;
                bus.addListener(late); // 新增：不应进入本轮派发
            }
        });
        const offSecond = bus.addListener(() => {
            calls.push('second');
            offSecond(); // 退订自身：本轮仍应派发完成
        });
        bus.addListener(() => calls.push('third'));

        bus.emit(endEvent());
        expect(calls).toEqual(['first', 'second', 'third']);
        expect(late).not.toHaveBeenCalled(); // 新增的监听器从下一轮开始生效

        bus.emit(endEvent());
        // 第二轮：first/third 仍在，second 已退订，late 生效
        expect(calls).toEqual(['first', 'second', 'third', 'first', 'third', 'late']);
    });
});

describe('createLoggerBridge', () => {
    function recordingLogger(): { logs: Array<[string, string]>; logger: Logger } {
        const logs: Array<[string, string]> = [];
        return {
            logs,
            logger: {
                debug: (m) => logs.push(['debug', m]),
                info: (m) => logs.push(['info', m]),
                warn: (m) => logs.push(['warn', m]),
                error: (m) => logs.push(['error', m]),
            },
        };
    }

    it('默认 info 级别：成功(debug)静默，5xx(warn)与错误(error)可见', () => {
        const { logs, logger } = recordingLogger();
        const bridge = createLoggerBridge(logger, 'info');
        bridge(endEvent({ status: 200 }));
        bridge(endEvent({ status: 503 }));
        bridge(endEvent({ error: { name: 'E', code: 'C', message: 'm' } }));
        expect(logs.map(([l]) => l)).toEqual(['warn', 'error']);
    });

    it('debug 级别全量可见', () => {
        const { logs, logger } = recordingLogger();
        const bridge = createLoggerBridge(logger, 'debug');
        bridge(endEvent({ status: 200 }));
        const retryEvent: TelemetryEvent = {
            type: 'retry:scheduled',
            requestId: 'r',
            method: 'GET',
            url: 'https://a.com',
            nextAttempt: 2,
            delayMs: 100,
            reason: 'HTTP 503',
            timestamp: 0,
        };
        bridge(retryEvent);
        expect(logs.length).toBe(2);
    });

    it('熔断状态变更以 warn 输出', () => {
        const { logs, logger } = recordingLogger();
        createLoggerBridge(logger, 'info')({
            type: 'circuit-breaker:state-change',
            from: 'closed',
            to: 'open',
            timestamp: 0,
        });
        expect(logs[0]![0]).toBe('warn');
    });
});
