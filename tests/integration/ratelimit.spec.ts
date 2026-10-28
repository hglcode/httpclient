import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, RateLimitRejectedError } from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;
let inFlight = 0;
let maxInFlight = 0;

beforeEach(async () => {
    inFlight = 0;
    maxInFlight = 0;
    server = await startServer(async (req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/work') {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 80)); // 模拟耗时下游
            inFlight--;
            res.end('done');
            return;
        }
        res.statusCode = 404;
        res.end();
    });
});

afterEach(async () => {
    await server.close();
});

describe('限流 / 并发控制（全链路）', () => {
    it('maxConcurrent 严格控制服务端可见并发', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            rateLimit: { maxConcurrent: 2 },
        });
        const results = await Promise.all(
            Array.from({ length: 10 }, () => client.fetch('/work')),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(maxInFlight).toBeLessThanOrEqual(2);
        // 全局 fetch 路径（Bun）的槽位归还挂在 body 完结的微任务上，让一拍再断言
        await new Promise((r) => setImmediate(r));
        expect(client.rateLimitSnapshot?.active).toBe(0);
        await client.close();
    });

    it('无限制时并发可达高位', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false });
        await Promise.all(Array.from({ length: 8 }, () => client.fetch('/work')));
        expect(maxInFlight).toBeGreaterThan(2);
        await client.close();
    });

    it('queueLimit 满 → queue-full 快速失败', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            rateLimit: { maxConcurrent: 1, queueLimit: 1, queueTimeoutMs: 10_000 },
        });
        const all = Promise.allSettled([
            client.fetch('/work'), // 占用
            client.fetch('/work'), // 排队（queueLimit=1）
            client.fetch('/work'), // 超限 → 拒绝
        ]);
        const outcomes = await all;
        expect(outcomes[0]!.status).toBe('fulfilled');
        expect(outcomes[1]!.status).toBe('fulfilled');
        expect(outcomes[2]!.status).toBe('rejected');
        expect((outcomes[2] as PromiseRejectedResult).reason).toBeInstanceOf(RateLimitRejectedError);
        expect(((outcomes[2] as PromiseRejectedResult).reason as RateLimitRejectedError).reason).toBe('queue-full');
        await client.close();
    });

    it('排队超时 → queue-timeout', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            rateLimit: { maxConcurrent: 1, queueTimeoutMs: 40 },
        });
        const first = client.fetch('/work'); // 占用 80ms
        await new Promise((r) => setTimeout(r, 5)); // 确保 first 先拿槽
        await expect(client.fetch('/work')).rejects.toMatchObject({
            name: 'RateLimitRejectedError',
            reason: 'queue-timeout',
        });
        await first;
        await client.close();
    });

    it('限流失败计入 stats.totalErrors 但不计入熔断', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            rateLimit: { maxConcurrent: 1, queueLimit: 0, queueTimeoutMs: 20 },
        });
        const first = client.fetch('/work');
        await new Promise((r) => setTimeout(r, 5));
        const second = client.fetch('/work');
        await expect(second).rejects.toBeInstanceOf(RateLimitRejectedError);
        await first;
        expect(client.stats.totalErrors).toBe(1);
        // 熔断 volume 仍为 1（只统计真正到达服务端的请求）
        expect(client.circuitBreakerSnapshot?.volume).toBe(1);
        await client.close();
    });

    it('限流排队中的请求最终按序发出（FIFO）', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            rateLimit: { maxConcurrent: 1 },
        });
        const order: number[] = [];
        const jobs = [1, 2, 3, 4].map((id) =>
            client.fetch('/work').then(() => order.push(id)),
        );
        await Promise.all(jobs);
        expect(order).toEqual([1, 2, 3, 4]);
        await client.close();
    });
});
