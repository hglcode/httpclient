import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, HttpError, NetworkError } from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;

beforeEach(async () => {
    server = await startServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        const hits = server.hits(path);
        if (path === '/flaky') {
            // 前两次 503，第三次成功
            if (hits <= 2) {
                res.statusCode = 503;
                res.end('unavailable');
            } else {
                res.end('{"ok":true}');
            }
            return;
        }
        if (path === '/flaky-retry-after') {
            if (hits <= 1) {
                res.statusCode = 429;
                res.setHeader('retry-after', '1'); // 1 秒
                res.end('rate limited');
            } else {
                res.end('{"ok":true}');
            }
            return;
        }
        if (path === '/always-503') {
            res.statusCode = 503;
            res.end('unavailable');
            return;
        }
        if (path === '/reset') {
            // 模拟网络层故障：直接断开连接
            res.socket?.destroy();
            return;
        }
        if (path === '/accepted') {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        res.statusCode = 404;
        res.end();
    });
});

afterEach(async () => {
    await server.close();
});

describe('重试策略（集成）', () => {
    it('503 → 重试 → 最终成功；服务端收到全部尝试', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10, jitter: 'none' },
        });
        const res = await client.fetch('/flaky');
        expect(res.status).toBe(200);
        expect(server.hits('/flaky')).toBe(3);
        expect(client.stats.totalRetries).toBe(2);
        await client.close();
    });

    it('Retry-After 头被遵循（429 + retry-after=1s）', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 1, initialDelayMs: 10_000, jitter: 'none', maxDelayMs: 10_000 },
        });
        const start = Date.now();
        const res = await client.fetch('/flaky-retry-after');
        const elapsed = Date.now() - start;
        expect(res.status).toBe(200);
        expect(elapsed).toBeGreaterThanOrEqual(900); // 至少等了 Retry-After 的绝大部分
        expect(server.hits('/flaky-retry-after')).toBe(2);
        await client.close();
    });

    it('网络层错误（连接被 RST）按 NetworkError 重试', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 2, initialDelayMs: 10 },
        });
        // /reset 永远断连 → 3 次尝试后以 NetworkError 失败
        await expect(client.fetch('/reset')).rejects.toBeInstanceOf(NetworkError);
        expect(server.hits('/reset')).toBe(3);
        expect(client.stats.totalRetries).toBe(2);
        await client.close();
    });

    it('404 不重试（不在 retryOnStatus）', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: { maxRetries: 3 } });
        const res = await client.fetch('/accepted');
        expect(res.status).toBe(404);
        expect(server.hits('/accepted')).toBe(1);
        await client.close();
    });

    it('POST 默认不重试（非幂等方法）', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10 },
        });
        const res = await client.fetch('/flaky', { method: 'POST', body: 'data' });
        expect(res.status).toBe(503);
        expect(server.hits('/flaky')).toBe(1); // 未重试
        await client.close();
    });

    it('POST 加入 methods 白名单后可重试', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10, methods: ['POST'] },
        });
        const res = await client.fetch('/flaky', { method: 'POST', body: 'data' });
        expect(res.status).toBe(200);
        expect(server.hits('/flaky')).toBe(3);
        await client.close();
    });

    it('重试预算耗尽 → 抛出最后一次错误（throwOnHttpError 时为 HttpError）', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 2, initialDelayMs: 10 },
        });
        await expect(
            client.fetch('/always-503', { throwOnHttpError: true }),
        ).rejects.toBeInstanceOf(HttpError);
        expect(server.hits('/always-503')).toBe(3);
        await client.close();
    });

    it('canRetry 钩子可否决重试', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10, canRetry: () => false },
        });
        const res = await client.fetch('/flaky');
        expect(res.status).toBe(503);
        expect(server.hits('/flaky')).toBe(1);
        await client.close();
    });

    it('per-request retry: false 关闭单请求重试', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10 },
        });
        const res = await client.fetch('/flaky', { retry: false });
        expect(res.status).toBe(503);
        expect(server.hits('/flaky')).toBe(1);
        await client.close();
    });

    it('retry:scheduled 遥测事件包含原因与延迟', async () => {
        const reasons: string[] = [];
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 2, initialDelayMs: 5 },
            telemetry: {
                onEvent: (event) => {
                    if (event.type === 'retry:scheduled') reasons.push(event.reason);
                },
            },
        });
        await client.fetch('/flaky');
        expect(reasons).toEqual(['HTTP 503', 'HTTP 503']);
        await client.close();
    });

    it('流式 body 不可重放 → 降级为单次请求', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10 },
        });
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('hello'));
                controller.close();
            },
        });
        const res = await client.fetch('/flaky', {
            method: 'POST',
            body: stream,
            duplex: 'half',
        });
        expect(res.status).toBe(503);
        expect(server.hits('/flaky')).toBe(1);
        await client.close();
    });
});
