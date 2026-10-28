/**
 * 冒烟验证：真实本地 server 上验证核心链路。
 * 运行：npx tsx scripts/smoke.ts
 */
import http from 'node:http';
import { HttpClient, HttpError, TimeoutError, CircuitOpenError } from '../src/index.js';

function createServer() {
    const hitsByPath = new Map<string, number>();
    let cookieSeen: string | undefined;
    const server = http.createServer((req, res) => {
        const url = req.url ?? '/';
        const path = url.split('?')[0] ?? '/';
        const hits = (hitsByPath.get(path) ?? 0) + 1;
        hitsByPath.set(path, hits);
        cookieSeen = req.headers.cookie;

        if (path === '/login') {
            res.setHeader('set-cookie', ['session=abc123; Path=/; HttpOnly', 'tracker=x; Path=/']);
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (path === '/whoami') {
            res.end(JSON.stringify({ cookie: cookieSeen ?? null }));
            return;
        }
        if (path === '/flaky') {
            // 前两次 503，第三次成功 → 验证重试
            if (hits % 3 !== 0) {
                res.statusCode = 503;
                res.setHeader('retry-after', '0');
                res.end('boom');
            } else {
                res.end(JSON.stringify({ recovered: true, hits }));
            }
            return;
        }
        if (path === '/slow') {
            setTimeout(() => res.end('finally'), 2000);
            return;
        }
        if (path === '/always500') {
            res.statusCode = 500;
            res.end('server error');
            return;
        }
        if (path === '/redirect') {
            res.statusCode = 302;
            res.setHeader('location', '/whoami');
            res.end();
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    });
    return { server, getHits: () => hitsByPath, getCookieSeen: () => cookieSeen };
}

async function main(): Promise<void> {
    const { server, getHits } = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}`;

    const client = new HttpClient({
        baseURL: base,
        timeout: 1000,
        retry: { maxRetries: 3, initialDelayMs: 30 },
        telemetry: {
            logger: {
                debug: () => {},
                warn: (m, c) => console.log('[warn]', m, JSON.stringify(c ?? {})),
                error: (m, c) => console.log('[error]', m, JSON.stringify(c ?? {})),
            },
            logLevel: 'info',
        },
    });

    // 1. 基本 GET + cookie 会话
    const login = await client.fetch('/login');
    console.log('1. login status:', login.status);
    const who = await client.fetch('/whoami');
    const whoBody = (await who.json()) as { cookie: string | null };
    console.log('1. cookie replay:', whoBody.cookie);

    // 2. 重试（503 x2 → 200）
    const flaky = await client.fetch('/flaky');
    console.log('2. flaky final status:', flaky.status, '| server hits:', getHits().get('/flaky'), '| totalRetries:', client.stats.totalRetries);

    // 3. 超时
    try {
        await client.fetch('/slow', { retry: false });
        console.log('3. TIMEOUT FAILED - no error thrown');
    } catch (err) {
        console.log('3. timeout error:', (err as Error).name, (err as TimeoutError).kind);
    }

    // 4. json 快捷方式 + POST
    const post = await client.fetch('/whoami', {
        method: 'POST',
        json: { hello: 'world' },
    });
    const postBody = (await post.json()) as { cookie: string | null };
    console.log('4. POST json status:', post.status, '| cookie still sent:', postBody.cookie !== null);

    // 5. throwOnHttpError（404）
    const client2 = new HttpClient({ baseURL: base });
    try {
        await client2.fetch('/nonexistent', { throwOnHttpError: true, retry: false });
    } catch (err) {
        const httpErr = err as HttpError;
        console.log('5. HttpError:', httpErr.name, httpErr.status, 'retryable:', httpErr.retryable);
    }

    // 6. 熔断（关闭重试，快速打满失败率）
    const cbClient = new HttpClient({
        baseURL: base,
        retry: false,
        circuitBreaker: { minimumVolume: 5, failureRateThreshold: 0.5, windowDurationMs: 5000 },
    });
    let circuitOpen = false;
    for (let i = 0; i < 12; i++) {
        try {
            await cbClient.fetch('/always500', { throwOnHttpError: true });
        } catch (err) {
            if (err instanceof CircuitOpenError) {
                circuitOpen = true;
                console.log('6. circuit opened at request', i + 1, '→', err.name);
                break;
            }
        }
    }
    if (!circuitOpen) console.log('6. CIRCUIT DID NOT OPEN');

    // 7. redirect follow (fetch native)
    const redirected = await client2.fetch('/redirect');
    console.log('7. redirect followed:', redirected.status, '→', new URL(redirected.url).pathname);

    // 8. stats
    const stats = client.stats;
    console.log('8. stats:', JSON.stringify({
        totalRequests: stats.totalRequests,
        totalRetries: stats.totalRetries,
        totalErrors: stats.totalErrors,
        statusCounts: stats.statusCounts,
        p50: Math.round(stats.duration.p50),
    }));

    await client.close();
    await client2.close();
    await cbClient.close();
    server.close();
    console.log('\nSMOKE OK');
}

main().catch((err) => {
    console.error('SMOKE FAILED:', err);
    process.exitCode = 1;
});
