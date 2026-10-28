import { describe, expect, it } from 'vitest';
import {
    CircuitBreaker,
    resolveCircuitBreakerOptions,
} from '../../src/interceptors/circuit-breaker.js';

function createBreaker(overrides: Partial<Parameters<typeof resolveCircuitBreakerOptions>[0]> = {}) {
    const options = resolveCircuitBreakerOptions({
        minimumVolume: 5,
        failureRateThreshold: 0.5,
        windowDurationMs: 10_000,
        buckets: 10,
        openDurationMs: 1000,
        halfOpenMaxProbes: 3,
        halfOpenSuccessThreshold: 2,
        ...overrides,
    })!;
    return new CircuitBreaker(options);
}

describe('CircuitBreaker 状态机', () => {
    it('未达最小样本量不熔断', () => {
        const breaker = createBreaker({ minimumVolume: 5 });
        let t = 0;
        for (let i = 0; i < 4; i++) {
            expect(breaker.beforeRequest(t).allowed).toBe(true);
            breaker.onFailure(false, t);
        }
        expect(breaker.snapshot(t).state).toBe('closed'); // 4/4 失败但 volume < 5
    });

    it('失败率达阈值且样本量足够 → open（成功采样后同样评估失败率）', () => {
        const breaker = createBreaker();
        let t = 0;
        // 3 失败 2 成功 = 60% ≥ 50%，volume=5 达到 minimumVolume
        for (let i = 0; i < 3; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        expect(breaker.snapshot(t).state).toBe('closed'); // volume=3 < 5
        for (let i = 0; i < 2; i++) {
            breaker.beforeRequest(t);
            breaker.onSuccess(false, t);
        }
        // 第 5 次采样（即使是成功）后评估：3/5 = 0.6 ≥ 0.5 → open
        expect(breaker.snapshot(t).state).toBe('open');
        expect(breaker.beforeRequest(t).allowed).toBe(false);
    });

    it('确切序列：5 样本 3 失败 → open，请求被拒并给出 retryInMs', () => {
        const breaker = createBreaker();
        let t = 1000;
        for (let i = 0; i < 3; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        for (let i = 0; i < 2; i++) {
            breaker.beforeRequest(t);
            breaker.onSuccess(false, t);
        }
        const admission = breaker.beforeRequest(t);
        expect(admission.allowed).toBe(false);
        if (!admission.allowed) {
            expect(admission.retryInMs).toBe(1000);
        }
        expect(breaker.snapshot(t).state).toBe('open');
    });

    it('open 期间快速失败；到期后进入 half-open 并放行探测', () => {
        const breaker = createBreaker();
        let t = 1000;
        for (let i = 0; i < 5; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        expect(breaker.beforeRequest(t).allowed).toBe(false); // open

        t += 1000; // openDurationMs 到期
        const probe = breaker.beforeRequest(t);
        expect(probe.allowed).toBe(true);
        if (probe.allowed) expect(probe.probe).toBe(true);
        expect(breaker.snapshot(t).state).toBe('half-open');
    });

    it('half-open 探测成功足够 → closed 且窗口清零', () => {
        const breaker = createBreaker({ halfOpenMaxProbes: 3, halfOpenSuccessThreshold: 2 });
        let t = 1000;
        for (let i = 0; i < 5; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        t += 1000;
        // 3 个探测，2 成功 1 失败 → 2 ≥ threshold → closed
        for (let i = 0; i < 2; i++) {
            const admission = breaker.beforeRequest(t);
            expect(admission.allowed).toBe(true);
            breaker.onSuccess(true, t);
        }
        const third = breaker.beforeRequest(t);
        expect(third.allowed).toBe(true);
        breaker.onFailure(true, t);
        expect(breaker.snapshot(t).state).toBe('closed');
        // 窗口已清零
        const snap = breaker.snapshot(t);
        expect(snap.volume).toBe(0);
    });

    it('half-open 首个探测失败即重新 open（阈值不可达优化）', () => {
        // halfOpenMaxProbes=3, threshold=3 → 任一失败即不可达
        const breaker = createBreaker({ halfOpenMaxProbes: 3, halfOpenSuccessThreshold: 3 });
        let t = 1000;
        for (let i = 0; i < 5; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        t += 1000;
        const admission = breaker.beforeRequest(t);
        expect(admission.allowed).toBe(true);
        breaker.onFailure(true, t); // 第一个探测失败 → 0+2 < 3 → 立即 open
        expect(breaker.snapshot(t).state).toBe('open');
    });

    it('half-open 探测名额占满时拒绝', () => {
        const breaker = createBreaker({ halfOpenMaxProbes: 2, halfOpenSuccessThreshold: 2 });
        let t = 1000;
        for (let i = 0; i < 5; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        t += 1000;
        expect(breaker.beforeRequest(t).allowed).toBe(true); // probe 1
        expect(breaker.beforeRequest(t).allowed).toBe(true); // probe 2
        const rejected = breaker.beforeRequest(t);
        expect(rejected.allowed).toBe(false);
    });

    it('滑动窗口：旧失败随时间滑出，失败率下降', () => {
        const breaker = createBreaker({ windowDurationMs: 1000, buckets: 10, minimumVolume: 4 });
        // t=0~100：4 次失败 → 100% 失败率 → open
        let t = 0;
        for (let i = 0; i < 4; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        expect(breaker.snapshot(t).state).toBe('open');
        // 1100ms 后（超过 openDurationMs=1000）→ half-open
        t += 1100;
        const probe = breaker.beforeRequest(t);
        expect(probe.allowed && probe.probe).toBe(true);
        breaker.onSuccess(true, t); // 1 成功但 < threshold=2，等待后续探测
        const probe2 = breaker.beforeRequest(t);
        expect(probe2.allowed && probe2.probe).toBe(true);
        breaker.onSuccess(true, t); // 达到阈值 → closed
        expect(breaker.snapshot(t).state).toBe('closed');
        // 窗口清零后，即使时间推进旧失败也不再计入
        t += 5000;
        const snap = breaker.snapshot(t);
        expect(snap.volume).toBe(0);
        expect(snap.state).toBe('closed');
    });

    it('onStateChange 回调触发', () => {
        const breaker = createBreaker();
        const transitions: string[] = [];
        breaker.onStateChange = (from, to) => transitions.push(`${from}->${to}`);
        let t = 0;
        for (let i = 0; i < 5; i++) {
            breaker.beforeRequest(t);
            breaker.onFailure(false, t);
        }
        expect(transitions).toEqual(['closed->open']);
    });

    it('resolveCircuitBreakerOptions: false → null，默认对象完整', () => {
        expect(resolveCircuitBreakerOptions(false)).toBeNull();
        const resolved = resolveCircuitBreakerOptions(undefined)!;
        expect(resolved.openDurationMs).toBe(30_000);
        expect([...resolved.failureStatusCodes]).toEqual([500, 502, 503, 504]);
        const custom = resolveCircuitBreakerOptions({ failureStatusCodes: [503] })!;
        expect([...custom.failureStatusCodes]).toEqual([503]);
    });
});
