import { describe, expect, it } from 'vitest';
import {
    computeBackoffMs,
    computeRetryDelayMs,
    isBodyReplayable,
    isMethodRetryable,
    isRetryableStatus,
    parseRetryAfterMs,
    resolveRetryOptions,
    DEFAULT_RETRY,
    type ResolvedRetryOptions,
} from '../../src/retry.js';
import type { RetryOptions } from '../../src/types.js';

function options(overrides: Partial<RetryOptions> = {}): ResolvedRetryOptions {
    const resolved = resolveRetryOptions({ ...overrides })!;
    return resolved;
}

describe('resolveRetryOptions', () => {
    it('false → null（禁用）', () => {
        expect(resolveRetryOptions(false)).toBeNull();
    });

    it('undefined → 默认值', () => {
        const resolved = resolveRetryOptions(undefined)!;
        expect(resolved.maxRetries).toBe(DEFAULT_RETRY.maxRetries);
        expect(resolved.jitter).toBe('half');
        expect(isRetryableStatus(503, resolved)).toBe(true);
        expect(isRetryableStatus(404, resolved)).toBe(false);
    });

    it('per-request 覆盖以构造器为基底', () => {
        const base = resolveRetryOptions({ maxRetries: 5, initialDelayMs: 10 })!;
        const perRequest = resolveRetryOptions({ maxRetries: 1 }, base)!;
        expect(perRequest.maxRetries).toBe(1);
        expect(perRequest.initialDelayMs).toBe(10); // 继承
    });

    it('canRetry 钩子可注入', () => {
        const canRetry = () => true;
        expect(resolveRetryOptions({ canRetry })!.canRetry).toBe(canRetry);
    });
});

describe('computeBackoffMs', () => {
    it('指数增长', () => {
        const opts = options({ jitter: 'none', initialDelayMs: 100, backoffFactor: 2 });
        expect(computeBackoffMs(2, opts)).toBe(100); // 第一次重试
        expect(computeBackoffMs(3, opts)).toBe(200);
        expect(computeBackoffMs(4, opts)).toBe(400);
    });

    it('maxDelayMs 封顶', () => {
        const opts = options({ jitter: 'none', initialDelayMs: 1000, backoffFactor: 10, maxDelayMs: 5000 });
        expect(computeBackoffMs(2, opts)).toBe(1000);
        expect(computeBackoffMs(3, opts)).toBe(5000); // 10000 → 5000
    });

    it('half jitter 落在 [delay/2, delay) 区间', () => {
        const opts = options({ jitter: 'half', initialDelayMs: 1000, backoffFactor: 1 });
        for (let i = 0; i < 200; i++) {
            const delay = computeBackoffMs(2, opts);
            expect(delay).toBeGreaterThanOrEqual(500);
            expect(delay).toBeLessThanOrEqual(1000);
        }
    });

    it('full jitter 落在 [0, delay) 区间', () => {
        const opts = options({ jitter: 'full', initialDelayMs: 1000, backoffFactor: 1 });
        for (let i = 0; i < 200; i++) {
            const delay = computeBackoffMs(2, opts);
            expect(delay).toBeGreaterThanOrEqual(0);
            expect(delay).toBeLessThanOrEqual(1000);
        }
    });
});

describe('parseRetryAfterMs', () => {
    it('秒数形式', () => {
        expect(parseRetryAfterMs('3')).toBe(3000);
        expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('HTTP-date 形式', () => {
        const future = new Date(Date.now() + 2500).toUTCString();
        const ms = parseRetryAfterMs(future)!;
        // RFC1123 日期为秒级精度（毫秒被截断），预留 ±1s 容差
        expect(ms).toBeGreaterThanOrEqual(1400);
        expect(ms).toBeLessThanOrEqual(3000);
    });

    it('过去时间截断为 0', () => {
        expect(parseRetryAfterMs(new Date(Date.now() - 10000).toUTCString())).toBe(0);
    });

    it('缺失 / 非法 → null', () => {
        expect(parseRetryAfterMs(null)).toBeNull();
        expect(parseRetryAfterMs('')).toBeNull();
        expect(parseRetryAfterMs('soon')).toBeNull();
    });
});

describe('computeRetryDelayMs', () => {
    it('优先使用 Retry-After', () => {
        const opts = options({ jitter: 'none', initialDelayMs: 1000 });
        expect(computeRetryDelayMs(2, opts, '2')).toBe(2000);
    });

    it('Retry-After 超过 maxDelayMs 时截断', () => {
        const opts = options({ jitter: 'none', initialDelayMs: 100, maxDelayMs: 5000 });
        expect(computeRetryDelayMs(2, opts, '120')).toBe(5000);
    });

    it('respectRetryAfter=false 忽略之', () => {
        const opts = options({ jitter: 'none', initialDelayMs: 100, respectRetryAfter: false });
        expect(computeRetryDelayMs(2, opts, '99')).toBe(100);
    });

    it('无 Retry-After 用退避', () => {
        const opts = options({ jitter: 'none', initialDelayMs: 250 });
        expect(computeRetryDelayMs(2, opts, null)).toBe(250);
    });
});

describe('isBodyReplayable', () => {
    it('可重放类型', () => {
        expect(isBodyReplayable(undefined)).toBe(true);
        expect(isBodyReplayable(null)).toBe(true);
        expect(isBodyReplayable('text')).toBe(true);
        expect(isBodyReplayable('{"a":1}')).toBe(true);
        expect(isBodyReplayable(new ArrayBuffer(8))).toBe(true);
        expect(isBodyReplayable(new Uint8Array(4))).toBe(true);
        expect(isBodyReplayable(new URLSearchParams('a=1'))).toBe(true);
    });

    it('流式类型不可重放', async () => {
        expect(isBodyReplayable(new ReadableStream())).toBe(false);
        const { Readable } = await import('node:stream');
        expect(isBodyReplayable(Readable.from(['a']))).toBe(false);
    });
});

describe('isMethodRetryable', () => {
    const opts = resolveRetryOptions(undefined)!;
    it('幂等方法默认可重试', () => {
        expect(isMethodRetryable('GET', opts)).toBe(true);
        expect(isMethodRetryable('get', opts)).toBe(true);
        expect(isMethodRetryable('HEAD', opts)).toBe(true);
        expect(isMethodRetryable('PUT', opts)).toBe(true);
        expect(isMethodRetryable('DELETE', opts)).toBe(true);
    });
    it('POST 默认不可重试', () => {
        expect(isMethodRetryable('POST', opts)).toBe(false);
    });
    it('自定义方法白名单', () => {
        const custom = resolveRetryOptions({ methods: ['POST'] })!;
        expect(isMethodRetryable('POST', custom)).toBe(true);
        expect(isMethodRetryable('GET', custom)).toBe(false);
    });
});
