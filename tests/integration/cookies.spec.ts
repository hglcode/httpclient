import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient, importCookies } from '../../src/index.js';
import { readBody, startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;
let cookieDirs: string[] = [];

beforeEach(async () => {
    server = await startServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/login') {
            res.setHeader('set-cookie', [
                'session=abc123; Path=/; HttpOnly',
                'tracker=xyz; Path=/',
            ]);
            res.end('{"ok":true}');
            return;
        }
        if (path === '/whoami') {
            res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
            return;
        }
        if (path === '/set-then-redirect') {
            res.setHeader('set-cookie', 'hop=1; Path=/');
            res.statusCode = 302;
            res.setHeader('location', '/whoami');
            res.end();
            return;
        }
        if (path === '/clear') {
            res.setHeader('set-cookie', 'session=; Path=/; Max-Age=0');
            res.end('cleared');
            return;
        }
        if (path === '/echo-headers') {
            void readBody(req).then(() => {
                res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
});

afterEach(async () => {
    await server.close();
    for (const dir of cookieDirs) rmSync(dir, { recursive: true, force: true });
    cookieDirs = [];
});

describe('Cookie 会话', () => {
    it('Set-Cookie 自动存储并在后续请求回带', async () => {
        const client = new HttpClient({ baseURL: server.url });
        await client.fetch('/login');
        const res = await client.fetch('/whoami');
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).toContain('session=abc123');
        expect(body.cookie).toContain('tracker=xyz');
        await client.close();
    });

    it('调用方显式 Cookie 头被完整尊重（不注入 jar cookie）', async () => {
        const client = new HttpClient({ baseURL: server.url });
        await client.fetch('/login'); // jar 有 cookie
        const res = await client.fetch('/echo-headers', {
            headers: { cookie: 'manual=override' },
        });
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).toBe('manual=override');
        await client.close();
    });

    it('重定向中间跳的 Set-Cookie 同样入库', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/set-then-redirect');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).toContain('hop=1');
        await client.close();
    });

    it('过期 cookie（Max-Age=0）被清除', async () => {
        const client = new HttpClient({ baseURL: server.url });
        await client.fetch('/login');
        await client.fetch('/clear');
        const res = await client.fetch('/whoami');
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).not.toContain('session=abc123');
        await client.close();
    });

    it('多实例隔离：不同 client 的 jar 互不可见', async () => {
        const clientA = new HttpClient({ baseURL: server.url });
        const clientB = new HttpClient({ baseURL: server.url });

        await clientA.fetch('/login');
        const b = await clientB.fetch('/whoami');
        const bBody = (await b.json()) as { cookie: string | null };
        expect(bBody.cookie).toBeNull();

        const a = await clientA.fetch('/whoami');
        const aBody = (await a.json()) as { cookie: string | null };
        expect(aBody.cookie).toContain('session=abc123');

        await clientA.close();
        await clientB.close();
    });

    it('cookies: false 完全无 cookie 行为', async () => {
        const client = new HttpClient({ baseURL: server.url, cookies: false });
        await client.fetch('/login');
        const res = await client.fetch('/whoami');
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).toBeNull();
        expect(client.jar).toBeNull();
        await client.close();
    });

    it('会话导出 / 导入（跨实例迁移登录态）', async () => {
        const source = new HttpClient({ baseURL: server.url });
        await source.fetch('/login');
        const session = source.exportSession();
        expect(session).not.toBeNull();

        const target = new HttpClient({ baseURL: server.url, cookies: false });
        // 导入到新实例：通过自定义 jar 构造
        const restored = new HttpClient({
            baseURL: server.url,
            cookies: { store: importCookies(session!).store ?? undefined },
        });
        const res = await restored.fetch('/whoami');
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).toContain('session=abc123');

        expect(target.jar).toBeNull();
        await source.close();
        await target.close();
        await restored.close();
    });
});

describe('FileCookieStore 持久化（多实例隔离 + 落盘）', () => {
    it('close() 落盘后，新 client 同 baseURL 恢复会话；不同 baseURL 互不串扰', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'it-cookies-'));
        cookieDirs.push(dir);

        const client1 = new HttpClient({ baseURL: server.url, cookies: { dir } });
        await client1.fetch('/login');
        await client1.close(); // 优雅落盘

        // 新进程语义：新 client 同 baseURL
        const client2 = new HttpClient({ baseURL: server.url, cookies: { dir } });
        const res = await client2.fetch('/whoami');
        const body = (await res.json()) as { cookie: string | null };
        expect(body.cookie).toContain('session=abc123');

        // 不同 baseURL（即便指向同一 server）使用独立文件
        const client3 = new HttpClient({ baseURL: `${server.url}/other`, cookies: { dir } });
        const res3 = await client3.fetch('/whoami');
        const body3 = (await res3.json()) as { cookie: string | null };
        expect(body3.cookie).toBeNull();

        await client2.close();
        await client3.close();
    });
});
