import { describe, expect, it } from 'vitest';
import {
    RequestLimiter,
    resolveRateLimitOptions,
} from '../../src/interceptors/rate-limit.js';

function createLimiter(overrides: Partial<Parameters<typeof resolveRateLimitOptions>[0]> = {}) {
    const options = resolveRateLimitOptions({
        maxConcurrent: 2,
        queueLimit: 0,
        queueTimeoutMs: 500,
        ...overrides,
    })!;
    return new RequestLimiter(options);
}

describe('RequestLimiter 并发控制', () => {
    it('并发槽位用尽后排队，release 后按 FIFO 放行', async () => {
        const limiter = createLimiter({ maxConcurrent: 2 });
        const order: number[] = [];

        const acquire = async (id: number, holdMs: number): Promise<void> => {
            await limiter.acquire();
            order.push(id);
            await new Promise((r) => setTimeout(r, holdMs));
            limiter.release();
        };

        await Promise.all([acquire(1, 40), acquire(2, 40), acquire(3, 5), acquire(4, 5)]);
        expect(order.slice(0, 2).sort((a, b) => a - b)).toEqual([1, 2]);
        expect(order.slice(2).sort((a, b) => a - b)).toEqual([3, 4]);
        expect(limiter.snapshot().active).toBe(0);
    });

    it('queueLimit 满时立即拒绝 queue-full', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, queueLimit: 1 });
        const first = limiter.acquire(); // 占用
        const queued = limiter.acquire(); // 排队
        await expect(limiter.acquire()).rejects.toMatchObject({
            name: 'RateLimitRejectedError',
            reason: 'queue-full',
        });
        limiter.release();
        void first;
        void queued;
        limiter.release();
    });

    it('排队超时 → queue-timeout', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, queueTimeoutMs: 50 });
        await limiter.acquire(); // 占用不放
        await expect(limiter.acquire()).rejects.toMatchObject({
            name: 'RateLimitRejectedError',
            reason: 'queue-timeout',
        });
        limiter.release();
    });

    it('dispose 拒绝所有排队者', async () => {
        const limiter = createLimiter({ maxConcurrent: 1 });
        await limiter.acquire();
        const pending = limiter.acquire();
        const pending2 = limiter.acquire();
        limiter.dispose();
        await expect(pending).rejects.toBeInstanceOf(Error);
        await expect(pending2).rejects.toBeInstanceOf(Error);
        await expect(limiter.acquire()).rejects.toBeInstanceOf(Error);
    });

    it('dispose 后 canGrant 恒为否，release 不复活', async () => {
        const limiter = createLimiter();
        await limiter.acquire();
        limiter.release();
        limiter.dispose();
        await expect(limiter.acquire()).rejects.toBeInstanceOf(Error);
    });
});

describe('RequestLimiter 令牌桶限速', () => {
    it('rps 限制下的放行节奏（真实短计时）', async () => {
        const limiter = createLimiter({ maxConcurrent: 10, requestsPerSecond: 40, burst: 1, queueTimeoutMs: 5000 });
        const start = Date.now();
        // burst=1 → 立即 1 个，其余按 25ms/个的节奏补充
        await Promise.all([
            limiter.acquire(),
            limiter.acquire(),
            limiter.acquire(),
            limiter.acquire(),
        ]);
        const elapsed = Date.now() - start;
        // 4 个令牌 ≈ 需要 3 次补充 ≈ 75ms；放宽下限避免抖动误报
        expect(elapsed).toBeGreaterThanOrEqual(50);
        expect(limiter.snapshot().availableTokens).not.toBeNull();
    });

    it('未启用 rps 时 availableTokens 为 null', () => {
        const limiter = createLimiter();
        expect(limiter.snapshot().availableTokens).toBeNull();
    });

    it('snapshot 反映 active/queued', async () => {
        const limiter = createLimiter({ maxConcurrent: 1 });
        await limiter.acquire();
        void limiter.acquire().catch(() => {});
        const snap = limiter.snapshot();
        expect(snap.active).toBe(1);
        expect(snap.queued).toBe(1);
        limiter.release();
    });
});

describe('resolveRateLimitOptions', () => {
    it('false / undefined → null', () => {
        expect(resolveRateLimitOptions(false)).toBeNull();
        expect(resolveRateLimitOptions(undefined)).toBeNull();
    });

    it('burst 默认取 ceil(rps)', () => {
        const resolved = resolveRateLimitOptions({ requestsPerSecond: 5 })!;
        expect(resolved.burst).toBe(5);
        expect(resolved.rps).toBe(5);
    });
});
