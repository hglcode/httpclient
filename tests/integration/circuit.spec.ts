import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CircuitOpenError, HttpClient, HttpError } from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;

beforeEach(async () => {
    server = await startServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/down') {
            res.statusCode = 500;
            res.end('down');
            return;
        }
        if (path === '/health') {
            res.end('{"status":"ok"}');
            return;
        }
        if (path === '/flaky-recover') {
            // 前 5 次 500，之后恢复
            if (server.hits(path) <= 5) {
                res.statusCode = 500;
                res.end('down');
            } else {
                res.end('up');
            }
            return;
        }
        res.statusCode = 404;
        res.end();
    });
});

afterEach(async () => {
    await server.close();
});

describe('熔断器（全链路）', () => {
    it('持续 5xx → 熔断打开 → CircuitOpenError 快速失败（不再打到服务端）', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            circuitBreaker: {
                minimumVolume: 4,
                failureRateThreshold: 0.5,
                windowDurationMs: 10_000,
                openDurationMs: 60_000,
            },
        });

        // 4 次失败（全部打到服务端）→ 熔断打开
        for (let i = 0; i < 4; i++) {
            await expect(
                client.fetch('/down', { throwOnHttpError: true }),
            ).rejects.toBeInstanceOf(HttpError);
        }
        expect(client.circuitBreakerSnapshot?.state).toBe('open');

        // 第 5 次起：CircuitOpenError，且不再打到服务端
        const before = server.hits('/down');
        await expect(client.fetch('/down')).rejects.toBeInstanceOf(CircuitOpenError);
        expect(server.hits('/down')).toBe(before);

        const snap = client.circuitBreakerSnapshot!;
        expect(snap.state).toBe('open');
        expect(snap.retryInMs).toBeGreaterThan(0);
        await client.close();
    });

    it('openDurationMs 到期 → 半开探测 → 成功恢复 closed', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            circuitBreaker: {
                minimumVolume: 3,
                failureRateThreshold: 0.5,
                windowDurationMs: 10_000,
                openDurationMs: 300, // 快速进入半开
                halfOpenMaxProbes: 3,
                halfOpenSuccessThreshold: 2,
            },
        });

        for (let i = 0; i < 3; i++) {
            await client.fetch('/down', { throwOnHttpError: true }).catch(() => {});
        }
        expect(client.circuitBreakerSnapshot?.state).toBe('open');

        // 等待进入半开
        await new Promise((r) => setTimeout(r, 350));
        expect(client.circuitBreakerSnapshot?.state).toBe('half-open');

        // 两个成功探测 → 恢复
        const r1 = await client.fetch('/health');
        expect(r1.status).toBe(200);
        expect(client.circuitBreakerSnapshot?.state).toBe('half-open');
        const r2 = await client.fetch('/health');
        expect(r2.status).toBe(200);
        expect(client.circuitBreakerSnapshot?.state).toBe('closed');
        await client.close();
    });

    it('circuit-breaker:state-change 遥测事件流', async () => {
        const transitions: string[] = [];
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            circuitBreaker: { minimumVolume: 2, openDurationMs: 60_000 },
            telemetry: {
                onEvent: (e) => {
                    if (e.type === 'circuit-breaker:state-change') {
                        transitions.push(`${e.from}->${e.to}`);
                    }
                },
            },
        });
        await client.fetch('/down', { throwOnHttpError: true }).catch(() => {});
        await client.fetch('/down', { throwOnHttpError: true }).catch(() => {});
        expect(transitions).toEqual(['closed->open']);
        await client.close();
    });

    it('重试与熔断协同：重试消耗熔断样本，熔断打开后剩余重试立即终止', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: { maxRetries: 5, initialDelayMs: 10 },
            circuitBreaker: { minimumVolume: 4, openDurationMs: 60_000 },
        });
        // 第一个请求的 6 次尝试（1+5 重试）中，第 4 次失败后熔断打开，
        // 剩余重试收到 CircuitOpenError（不可重试）→ 立即失败
        await expect(client.fetch('/down', { throwOnHttpError: true })).rejects.toBeInstanceOf(
            CircuitOpenError,
        );
        expect(client.circuitBreakerSnapshot?.state).toBe('open');
        // 服务端实际被打到 4 次（而非 6 次）
        expect(server.hits('/down')).toBe(4);
        await client.close();
    });

    it('4xx 不计入熔断失败', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            circuitBreaker: { minimumVolume: 5, failureRateThreshold: 0.5 },
        });
        for (let i = 0; i < 10; i++) {
            const res = await client.fetch('/missing');
            expect(res.status).toBe(404);
        }
        expect(client.circuitBreakerSnapshot?.state).toBe('closed');
        expect(client.circuitBreakerSnapshot?.failures).toBe(0);
        await client.close();
    });

    it('circuitBreaker: false 关闭熔断', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            circuitBreaker: false,
        });
        for (let i = 0; i < 10; i++) {
            await client.fetch('/down', { throwOnHttpError: true }).catch(() => {});
        }
        expect(client.circuitBreakerSnapshot).toBeNull();
        expect(server.hits('/down')).toBe(10); // 全部打到服务端
        await client.close();
    });

    it('stats 快照暴露熔断状态', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            circuitBreaker: { minimumVolume: 2, openDurationMs: 60_000 },
        });
        await client.fetch('/down', { throwOnHttpError: true }).catch(() => {});
        await client.fetch('/down', { throwOnHttpError: true }).catch(() => {});
        expect(client.stats.circuitBreaker?.state).toBe('open');
        expect(client.stats.totalErrors).toBe(2);
        await client.close();
    });
});
