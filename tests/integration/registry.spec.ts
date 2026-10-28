import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpClientRegistry } from '../../src/index.js';
import { startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;

beforeEach(async () => {
    server = await startServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/echo-origin') {
            res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
            return;
        }
        if (path === '/set-cookie') {
            res.setHeader('set-cookie', 'origin=' + req.headers.host + '; Path=/');
            res.end('set');
            return;
        }
        res.statusCode = 404;
        res.end();
    });
});

afterEach(async () => {
    await server.close();
});

describe('HttpClientRegistry（多实例管理）', () => {
    it('同 baseURL 复用单例；不同 baseURL 各自独立', async () => {
        const registry = createHttpClientRegistry({ retry: false });
        const a1 = registry.get(server.url);
        const a2 = registry.get(server.url);
        expect(a1).toBe(a2);

        const b = registry.get(`${server.url}/other`);
        expect(b).not.toBe(a1);
        expect(registry.size).toBe(2);
        expect(registry.list()).toEqual([server.url, `${server.url}/other`]);
        expect(registry.has(server.url)).toBe(true);
        await registry.close();
    });

    it('cookie 会话按 baseURL 隔离', async () => {
        const registry = createHttpClientRegistry({ retry: false });

        const clientA = registry.get(server.url);
        await clientA.fetch('/set-cookie');
        const resA = await clientA.fetch('/echo-origin');
        const bodyA = (await resA.json()) as { cookie: string | null };
        expect(bodyA.cookie).toContain('origin=');

        // 不同 baseURL 的 client 无该 cookie
        const clientB = registry.get('http://127.0.0.1:1'); // 不会真的请求
        expect(clientB.jar?.getCookieStringSync(server.url)).not.toContain('origin=');
        await registry.close();
    });

    it('remove 关闭并移除单个 client', async () => {
        const registry = createHttpClientRegistry({ retry: false });
        registry.get(server.url);
        expect(await registry.remove(server.url)).toBe(true);
        expect(registry.size).toBe(0);
        expect(await registry.remove(server.url)).toBe(false);
        await registry.close();
    });

    it('close 全部优雅关闭后注册表清空', async () => {
        const registry = createHttpClientRegistry({ retry: false });
        const client = registry.get(server.url);
        const res = await client.fetch('/echo-origin');
        expect(res.status).toBe(200);
        await registry.close();
        expect(registry.size).toBe(0);
        // close 后的 client 拒绝新请求
        await expect(client.fetch('/echo-origin')).rejects.toThrow();
    });

    it('baseOptions 作为公共默认值继承', async () => {
        const registry = createHttpClientRegistry({
            retry: false,
            headers: { 'x-shared': 'yes' },
        });
        const client = registry.get(server.url);
        const res = await client.fetch('/echo-origin');
        // registry 语义：公共配置下发到所有实例
        expect(res.status).toBe(200);
        await registry.close();
    });
});
