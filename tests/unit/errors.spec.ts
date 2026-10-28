import { describe, expect, it } from 'vitest';
import {
    CircuitOpenError,
    ERROR_CODES,
    HttpError,
    InvalidUrlError,
    isRetryableError,
    NetworkError,
    normalizeFetchError,
    RateLimitRejectedError,
    RequestAbortedError,
    TimeoutError,
} from '../../src/errors.js';
import type { CircuitBreakerSnapshot } from '../../src/interceptors/circuit-breaker.js';

const snapshot: CircuitBreakerSnapshot = {
    state: 'open',
    volume: 10,
    failures: 8,
    failureRate: 0.8,
    openedAgoMs: 100,
    retryInMs: 29_900,
};

describe('错误树基本属性', () => {
    it('code / retryable / name', () => {
        expect(new NetworkError('x').code).toBe(ERROR_CODES.NETWORK);
        expect(new NetworkError('x').retryable).toBe(true);
        expect(new TimeoutError('total', 'x').retryable).toBe(true);
        expect(new RequestAbortedError().retryable).toBe(false);
        expect(new CircuitOpenError(snapshot, 1000).retryable).toBe(false);
        expect(new RateLimitRejectedError('queue-full', 'x').retryable).toBe(true);
        expect(new InvalidUrlError('x').retryable).toBe(false);
    });

    it('HttpError 按状态码推导 retryable', () => {
        const make = (status: number) =>
            new HttpError({ url: 'https://a.com', status, statusText: 'x', headers: {}, body: '' });
        expect(make(503).retryable).toBe(true);
        expect(make(429).retryable).toBe(true);
        expect(make(408).retryable).toBe(true);
        expect(make(404).retryable).toBe(false);
        expect(make(401).retryable).toBe(false);
    });

    it('HttpError 携带响应上下文', () => {
        const err = new HttpError({
            url: 'https://a.com/x',
            status: 400,
            statusText: 'Bad Request',
            headers: { 'x-request-id': 'abc' },
            body: 'invalid input',
        });
        expect(err.status).toBe(400);
        expect(err.headers['x-request-id']).toBe('abc');
        expect(err.body).toBe('invalid input');
        expect(err.message).toContain('HTTP 400');
    });

    it('cause 链保留', () => {
        const cause = new Error('ECONNRESET');
        const err = new NetworkError('net down', cause);
        expect(err.cause).toBe(cause);
    });

    it('isRetryableError 判定', () => {
        expect(isRetryableError(new NetworkError('x'))).toBe(true);
        expect(isRetryableError(new RequestAbortedError())).toBe(false);
        expect(isRetryableError(new Error('plain'))).toBe(false);
    });
});

describe('normalizeFetchError', () => {
    const ctx = { url: 'https://a.com', method: 'GET' };

    it('HttpClientError 原样返回', () => {
        const original = new NetworkError('already typed');
        expect(normalizeFetchError(original, ctx)).toBe(original);
    });

    it('解包 fetch 的 TypeError 包装（cause 链中的类型化错误）', () => {
        const inner = new CircuitOpenError(snapshot, 5000);
        const wrapped = new TypeError('fetch failed', { cause: inner });
        const result = normalizeFetchError(wrapped, ctx);
        expect(result).toBe(inner);
    });

    it('signal 已中止且 reason 为 TimeoutError → TimeoutError(total)', async () => {
        const timeoutSignal = AbortSignal.timeout(10);
        await new Promise((r) => setTimeout(r, 30)); // 等待超时触发
        expect(timeoutSignal.aborted).toBe(true);
        const err = new DOMException('The operation was aborted', 'AbortError');
        const result = normalizeFetchError(err, { ...ctx, signal: timeoutSignal, timeoutMs: 10 });
        expect(result).toBeInstanceOf(TimeoutError);
        expect((result as TimeoutError).kind).toBe('total');
    });

    it('signal 用户中止 → RequestAbortedError 且保留 reason', () => {
        const controller = new AbortController();
        const reason = new Error('user cancelled');
        controller.abort(reason);
        const result = normalizeFetchError(new DOMException('aborted', 'AbortError'), {
            ...ctx,
            signal: controller.signal,
        });
        expect(result).toBeInstanceOf(RequestAbortedError);
        expect((result as RequestAbortedError).reason).toBe(reason);
    });

    it('DOMException TimeoutError（AbortSignal.timeout 直抛）→ TimeoutError', () => {
        const timeoutError = AbortSignal.timeout(1);
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                const result = normalizeFetchError(timeoutError.reason, { ...ctx, timeoutMs: 1 });
                expect(result).toBeInstanceOf(TimeoutError);
                resolve();
            }, 20);
        });
    });

    it('cause 链中的 errno → NetworkError', () => {
        const socketError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), {
            code: 'ECONNREFUSED',
        });
        const wrapped = new TypeError('fetch failed', { cause: socketError });
        const result = normalizeFetchError(wrapped, ctx);
        expect(result).toBeInstanceOf(NetworkError);
        expect((result as NetworkError).cause).toBe(wrapped);
    });

    it('cause 链中的 undici 超时标记 → TimeoutError(kind)', () => {
        const cases: Array<[string, string, TimeoutError['kind']]> = [
            ['HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT', 'headers'],
            ['BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT', 'body'],
            ['ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT', 'connect'],
        ];
        for (const [name, code, kind] of cases) {
            const deep = Object.assign(new Error('timeout'), { name });
            const mid = Object.assign(new Error('mid'), { code });
            // 两层分别测试：marker 在链尾（name）与链中（code）均可识别
            expect((normalizeFetchError(new TypeError('f', { cause: deep }), ctx) as TimeoutError).kind).toBe(kind);
            expect((normalizeFetchError(new TypeError('f', { cause: mid }), ctx) as TimeoutError).kind).toBe(kind);
        }
    });

    it('未知 TypeError → 兜底 NetworkError', () => {
        const result = normalizeFetchError(new TypeError('fetch failed'), ctx);
        expect(result).toBeInstanceOf(NetworkError);
        expect(result.retryable).toBe(true);
    });
});
