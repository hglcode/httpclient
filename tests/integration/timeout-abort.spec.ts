import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, RequestAbortedError, TimeoutError } from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;

beforeEach(async () => {
    server = await startServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/slow') {
            setTimeout(() => res.end('late'), 3000);
            return;
        }
        if (path === '/flaky-slow') {
            // 前两次超慢（触发调用方超时），第三次快
            if (server.hits(path) <= 2) {
                setTimeout(() => res.end('late'), 3000);
            } else {
                res.end('fast');
            }
            return;
        }
        if (path === '/slow-body') {
            // 头立即返回，body 慢速滴流 → 测试 body 阶段超时语义
            res.writeHead(200, { 'content-type': 'text/plain' });
            const timer = setInterval(() => res.write('x'), 400);
            setTimeout(() => {
                clearInterval(timer);
                res.end();
            }, 3000);
            return;
        }
        res.statusCode = 404;
        res.end();
    });
});

afterEach(async () => {
    await server.close();
});

describe('超时与中止', () => {
    it('总超时触发 → TimeoutError(kind=total)', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false, timeout: 300 });
        try {
            await client.fetch('/slow');
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(TimeoutError);
            expect((err as TimeoutError).kind).toBe('total');
        }
        await client.close();
    });

    it('per-request timeout 覆盖构造器默认', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false, timeout: 5000 });
        await expect(client.fetch('/slow', { timeout: 300 })).rejects.toBeInstanceOf(TimeoutError);
        await client.close();
    });

    it('超时可重试：每次尝试有独立的新鲜超时预算', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 3, initialDelayMs: 10 },
            timeout: 400,
        });
        const start = Date.now();
        const res = await client.fetch('/flaky-slow');
        // 两次超时(400x2) + 退避 + 第三次成功
        expect(res.status).toBe(200);
        expect(Date.now() - start).toBeGreaterThanOrEqual(700);
        expect(server.hits('/flaky-slow')).toBe(3);
        await client.close();
    }, 15_000);

    it('用户 abort → RequestAbortedError（保留 reason）', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false });
        const controller = new AbortController();
        const reason = new Error('cancelled by test');
        const pending = client.fetch('/slow', { signal: controller.signal });
        setTimeout(() => controller.abort(reason), 100);
        try {
            await pending;
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(RequestAbortedError);
            expect((err as RequestAbortedError).reason).toBe(reason);
        }
        await client.close();
    });

    it('退避等待期间 abort → 立即失败而非继续重试', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 5, initialDelayMs: 3000, jitter: 'none' },
        });
        const controller = new AbortController();
        const pending = client.fetch('/slow', {
            method: 'PUT', // 幂等方法 → 超时可重试
            signal: controller.signal,
            timeout: 100,
        });
        // 等第一次超时进入退避等待（3000ms）后 abort
        setTimeout(() => controller.abort(new Error('stop retrying')), 300);
        const start = Date.now();
        try {
            await pending;
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(RequestAbortedError);
            // 未等完 3000ms 退避
            expect(Date.now() - start).toBeLessThan(2000);
        }
        await client.close();
    }, 10_000);

    it('timeout=0 / 未设置 → 不限总超时（依赖 undici 默认 headers/body 超时）', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false, timeout: 0 });
        const res = await client.fetch('/slow-body', { timeout: 0 });
        // 3 秒慢 body 能正常读完（无总超时限制）
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('x');
        await client.close();
    }, 10_000);
});
