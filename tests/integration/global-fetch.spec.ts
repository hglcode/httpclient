/**
 * 全局 fetch 路径（bun-compat.fetchViaGlobal）专属集成测试。
 *
 * Node 下 HttpClient 默认走 dispatcher 拦截链，不会触发该路径；
 * 本文件直接调用 fetchViaGlobal 覆盖其独有行为：
 * 手动重定向循环（逐跳 cookie / 方法转换 / 跳数上限）、
 * 限流槽的 body 完结归还、熔断全链路、redirected 标记等。
 * 同一文件在 Bun（bun test）与 Node（vitest）下均执行，
 * 保证两条运行时的全局路径行为一致。
 */
import { describe, it, expect } from 'vitest';
import { CookieJar, MemoryCookieStore } from 'tough-cookie';
import { fetchViaGlobal } from '../../src/bun-compat.js';
import type { GlobalFetchDeps } from '../../src/bun-compat.js';
import {
    CircuitBreaker,
    resolveCircuitBreakerOptions,
} from '../../src/interceptors/circuit-breaker.js';
import { RequestLimiter, resolveRateLimitOptions } from '../../src/interceptors/rate-limit.js';
import { CircuitOpenError } from '../../src/errors.js';
import { startServer, type TestServer } from '../helpers/server.js';

function noopDeps(overrides: Partial<GlobalFetchDeps> = {}): GlobalFetchDeps {
    return {
        limiter: null,
        breaker: null,
        failureStatusCodes: new Set([500, 502, 503, 504]),
        jar: null,
        ...overrides,
    };
}

function makeJar(): CookieJar {
    return new CookieJar(new MemoryCookieStore());
}

function call(
    server: TestServer,
    path: string,
    init: Partial<GlobalFetchDeps> & Record<string, unknown> = {},
    extraInit: Record<string, unknown> = {},
): Promise<Response> {
    return fetchViaGlobal(
        {
            url: `${server.url}${path}`,
            init: {
                method: 'GET',
                headers: {},
                ...extraInit,
            } as Parameters<typeof fetchViaGlobal>[0]['init'],
        },
        noopDeps(init as Partial<GlobalFetchDeps>),
    );
}

describe('全局 fetch 路径（fetchViaGlobal）', () => {
    it('重定向 follow：逐跳 Set-Cookie 入库，最终 redirected=true', async () => {
        const server = await startServer((req, res) => {
            if (req.url === '/a') {
                res.setHeader('set-cookie', 'first=a; Path=/');
                res.statusCode = 302;
                res.setHeader('location', '/b');
                res.end();
            } else if (req.url === '/b') {
                res.setHeader('set-cookie', 'second=b; Path=/');
                res.statusCode = 302;
                res.setHeader('location', '/c');
                res.end();
            } else {
                res.statusCode = 200;
                res.end('final');
            }
        });
        try {
            const jar = makeJar();
            const res = await call(server, '/a', { jar });
            expect(res.status).toBe(200);
            expect(res.redirected).toBe(true);
            expect(await res.text()).toBe('final');
            const cookies = jar
                .getCookiesSync(`${server.url}/`)
                // tough-cookie 6：Cookie 属性名为 key（v5 及更早为 name）
                .map((c) => `${c.key}=${c.value}`)
                .sort();
            expect(cookies).toEqual(['first=a', 'second=b']);
        } finally {
            await server.close();
        }
    });

    it('303：POST 转 GET，body 丢弃且 content-type 不转发', async () => {
        const server = await startServer((req, res) => {
            if (req.url === '/see-other') {
                res.statusCode = 303;
                res.setHeader('location', '/echo');
                res.end();
            } else if (req.url === '/echo') {
                const chunks: Buffer[] = [];
                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () => {
                    res.statusCode = 200;
                    res.end(
                        JSON.stringify({
                            method: req.method,
                            contentType: req.headers['content-type'] ?? null,
                            body: Buffer.concat(chunks).toString('utf8'),
                        }),
                    );
                });
            }
        });
        try {
            const res = await call(server, '/see-other', {}, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"x":1}',
            });
            expect(res.status).toBe(200);
            const seen = JSON.parse(await res.text()) as {
                method: string;
                contentType: string | null;
                body: string;
            };
            expect(seen.method).toBe('GET');
            expect(seen.contentType).toBeNull();
            expect(seen.body).toBe('');
        } finally {
            await server.close();
        }
    });

    it('307：方法与 body 原样转发', async () => {
        const server = await startServer((req, res) => {
            if (req.url === '/temp-redirect') {
                res.statusCode = 307;
                res.setHeader('location', '/echo');
                res.end();
            } else {
                const chunks: Buffer[] = [];
                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () => {
                    res.statusCode = 200;
                    res.end(
                        JSON.stringify({
                            method: req.method,
                            body: Buffer.concat(chunks).toString('utf8'),
                        }),
                    );
                });
            }
        });
        try {
            const res = await call(server, '/temp-redirect', {}, {
                method: 'POST',
                headers: {},
                body: 'payload-307',
            });
            expect(res.status).toBe(200);
            const seen = JSON.parse(await res.text()) as { method: string; body: string };
            expect(seen.method).toBe('POST');
            expect(seen.body).toBe('payload-307');
        } finally {
            await server.close();
        }
    });

    it('307 + 不可重放的流式 body → 返回 3xx 不跟随（由调用方决策）', async () => {
        const server = await startServer((req, res) => {
            res.statusCode = 307;
            res.setHeader('location', '/echo');
            res.end();
        });
        try {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('stream-data'));
                    controller.close();
                },
            });
            const res = await call(server, '/temp-redirect', {}, {
                method: 'POST',
                headers: {},
                body: stream,
            });
            expect(res.status).toBe(307);
            expect(res.headers.get('location')).toBe('/echo');
            await res.body?.cancel();
        } finally {
            await server.close();
        }
    });

    it('重定向超过 20 跳 → 抛错（与 undici fetch 上限一致）', async () => {
        const server = await startServer((req, res) => {
            res.statusCode = 302;
            res.setHeader('location', '/loop');
            res.end();
        });
        try {
            await expect(call(server, '/loop')).rejects.toThrow(/exceeded 20 redirects/i);
        } finally {
            await server.close();
        }
    });

    it('调用方显式 Cookie 头优先，不做 jar 注入', async () => {
        let seenCookie = 'unset';
        const server = await startServer((req, res) => {
            seenCookie = req.headers.cookie ?? 'unset';
            res.end('ok');
        });
        try {
            const jar = makeJar();
            jar.setCookieSync('jar-cookie=1; Path=/', server.url);
            await call(server, '/x', { jar }, { headers: { cookie: 'custom=1' } });
            expect(seenCookie).toBe('custom=1');
        } finally {
            await server.close();
        }
    });

    it('redirect: manual 模式原样返回 3xx 响应', async () => {
        const server = await startServer((req, res) => {
            res.statusCode = 302;
            res.setHeader('location', '/elsewhere');
            res.end();
        });
        try {
            const res = await call(server, '/x', {}, { redirect: 'manual' });
            expect(res.status).toBe(302);
            expect(res.redirected).toBe(false);
            await res.body?.cancel();
        } finally {
            await server.close();
        }
    });

    it('限流槽在响应 body 完结时归还（而非响应头到达时）', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('part1-');
            // 慢速第二段，确保 fetch resolve 时 body 尚未完结
            setTimeout(() => res.end('part2'), 120);
        });
        try {
            const limiter = new RequestLimiter(
                resolveRateLimitOptions({ maxConcurrent: 1, queueLimit: 1 })!,
            );
            const res = await call(server, '/slow-body', { limiter });
            expect(res.status).toBe(200);

            // 响应头已到、body 未读完 → 槽位仍被占用
            expect(limiter.snapshot().active).toBe(1);

            const text = await res.text();
            expect(text).toBe('part1-part2');
            // pipeTo 的归还回调是微任务：让一拍事件循环后再断言
            await new Promise((resolve) => setImmediate(resolve));
            // body 完结 → 槽位归还
            expect(limiter.snapshot().active).toBe(0);
        } finally {
            await server.close();
        }
    });

    it('熔断全链路：失败率达阈值 → open → CircuitOpenError 快速失败', async () => {
        const server = await startServer((req, res) => {
            res.statusCode = 503;
            res.end('unavailable');
        });
        try {
            const options = resolveCircuitBreakerOptions({
                minimumVolume: 4,
                failureRateThreshold: 0.5,
                windowDurationMs: 10_000,
                buckets: 10,
            })!;
            const breaker = new CircuitBreaker(options);
            const deps = { ...noopDeps(), breaker, failureStatusCodes: options.failureStatusCodes };

            const attempt = (): Promise<Response> =>
                fetchViaGlobal(
                    {
                        url: `${server.url}/flaky`,
                        init: { method: 'GET', headers: {} },
                    },
                    deps,
                );

            // 4 次失败（minimumVolume=4，失败率 100% ≥ 0.5）→ 熔断打开
            for (let i = 0; i < 4; i++) {
                const res = await attempt();
                await res.body?.cancel();
            }
            expect(breaker.state).toBe('open');
            // 第 5 次：快速失败，不触网
            const hitsBefore = server.totalHits();
            await expect(attempt()).rejects.toBeInstanceOf(CircuitOpenError);
            expect(server.totalHits()).toBe(hitsBefore);
        } finally {
            await server.close();
        }
    });

    it('传输错误计入熔断失败（连接被拒场景）', async () => {
        // 端口 1 几乎必然无监听 → 连接立即被拒
        const options = resolveCircuitBreakerOptions({
            minimumVolume: 2,
            failureRateThreshold: 0.5,
        })!;
        const breaker = new CircuitBreaker(options);
        const deps = { ...noopDeps(), breaker, failureStatusCodes: options.failureStatusCodes };

        for (let i = 0; i < 2; i++) {
            await expect(
                fetchViaGlobal(
                    { url: 'http://127.0.0.1:1/x', init: { method: 'GET', headers: {} } },
                    deps,
                ),
            ).rejects.toThrow();
        }
        expect(breaker.state).toBe('open');
    });
});
