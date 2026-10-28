import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, HttpError, InvalidUrlError } from '../../src/index.js';
import { readBody, startServer, type TestServer } from '../helpers/server.js';

let server: TestServer;

beforeEach(async () => {
    server = await startServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        if (path === '/echo') {
            void readBody(req).then((body) => {
                res.setHeader('content-type', req.headers['content-type'] ?? 'text/plain');
                res.end(
                    JSON.stringify({
                        method: req.method,
                        body,
                        contentType: req.headers['content-type'] ?? null,
                        accept: req.headers['accept'] ?? null,
                        search: new URL(req.url ?? '/', 'http://x').search,
                    }),
                );
            });
            return;
        }
        if (path === '/redirect') {
            res.statusCode = 302;
            res.setHeader('location', '/echo');
            res.end();
            return;
        }
        if (path === '/error') {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'bad_input', details: 'x'.repeat(300) }));
            return;
        }
        if (path === '/big-error') {
            res.statusCode = 500;
            res.setHeader('content-type', 'text/plain');
            res.end(Buffer.alloc(256 * 1024, 65)); // 256KB 错误响应体
            return;
        }
        if (path === '/binary') {
            const buf = Buffer.alloc(256 * 1024, 7); // 256KB
            res.setHeader('content-length', String(buf.length));
            res.end(buf);
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    });
});

afterEach(async () => {
    await server.close();
});

describe('HttpClient 基本语义', () => {
    it('GET 返回标准 Response', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/echo?x=1');
        expect(res.status).toBe(200);
        expect(res.ok).toBe(true);
        const body = (await res.json()) as { method: string };
        expect(body.method).toBe('GET');
        await client.close();
    });

    it('POST body 与 content-type 透传', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/echo', {
            method: 'POST',
            headers: { 'content-type': 'text/csv' },
            body: 'a,b,c',
        });
        const body = (await res.json()) as { body: string; contentType: string };
        expect(body.body).toBe('a,b,c');
        expect(body.contentType).toBe('text/csv');
        await client.close();
    });

    it('json 快捷方式自动序列化并设置 content-type', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/echo', { method: 'POST', json: { a: 1 } });
        const body = (await res.json()) as { body: string; contentType: string };
        expect(JSON.parse(body.body)).toEqual({ a: 1 });
        expect(body.contentType).toBe('application/json');
        await client.close();
    });

    it('json 与 body 同时给 → TypeError', async () => {
        const client = new HttpClient({ baseURL: server.url });
        await expect(
            client.fetch('/echo', { method: 'POST', json: { a: 1 }, body: 'x' }),
        ).rejects.toThrow(TypeError);
        await client.close();
    });

    it('searchParams 对象追加查询参数', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/echo', { searchParams: { page: 2, tag: 'x y' } });
        const body = (await res.json()) as { search: string };
        expect(body.search).toBe('?page=2&tag=x+y');
        await client.close();
    });

    it('默认头可被 per-request 覆盖', async () => {
        const client = new HttpClient({
            baseURL: server.url,
            headers: { accept: 'application/json', 'x-env': 'test' },
        });
        const res = await client.fetch('/echo', { headers: { accept: 'text/html' } });
        const body = (await res.json()) as { accept: string | null };
        expect(body.accept).toBe('text/html');
        await client.close();
    });

    it('URL 解析：绝对 URL 覆盖 baseURL；/ 前缀相对 origin', async () => {
        const client = new HttpClient({ baseURL: `${server.url}/api/v1` });
        const res1 = await client.fetch('/echo'); // → /echo（origin 根）
        expect(res1.status).toBe(200);

        const res2 = await client.fetch('echo'); // → /api/v1/echo → 404 路径
        expect(res2.status).toBe(404);

        const res3 = await client.fetch(`${server.url}/echo`); // 绝对 URL
        expect(res3.status).toBe(200);
        await client.close();
    });

    it('非法 baseURL 构造期早失败', () => {
        expect(() => new HttpClient({ baseURL: '::::' })).toThrow(InvalidUrlError);
    });

    it('fetch 语义：404 默认不抛错', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false });
        const res = await client.fetch('/missing');
        expect(res.status).toBe(404);
        expect(res.ok).toBe(false);
        await client.close();
    });

    it('throwOnHttpError：抛 HttpError 且携带响应上下文', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false });
        try {
            await client.fetch('/error', { throwOnHttpError: true });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(HttpError);
            const httpErr = err as HttpError;
            expect(httpErr.status).toBe(400);
            expect(httpErr.statusText).toBe('Bad Request');
            expect(httpErr.headers['content-type']).toBe('application/json');
            const parsed = JSON.parse(httpErr.body) as { error: string };
            expect(parsed.error).toBe('bad_input');
            expect(httpErr.retryable).toBe(false);
        }
        await client.close();
    });

    it('HttpError body 快照截断到 64KB（大错误体不炸内存/日志）', async () => {
        const client = new HttpClient({ baseURL: server.url, retry: false });
        try {
            await client.fetch('/big-error', { throwOnHttpError: true });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(HttpError);
            const httpErr = err as HttpError;
            expect(httpErr.status).toBe(500);
            // 精确截断到 64KiB 字符数
            expect(httpErr.body.length).toBe(64 * 1024);
        }
        await client.close();
    });

    it('重定向默认 follow（fetch 原生语义）', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/redirect');
        expect(res.status).toBe(200);
        expect(res.redirected).toBe(true);
        const body = (await res.json()) as { method: string };
        expect(body.method).toBe('GET');
        await client.close();
    });

    it('redirect: manual 模式返回 3xx 响应', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/redirect', { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/echo');
        await client.close();
    });

    it('遥测事件序列（start x N / retry / end）', async () => {
        const events: string[] = [];
        const client = new HttpClient({
            baseURL: server.url,
            retry: false,
            telemetry: { onEvent: (e) => events.push(e.type) },
        });
        await client.fetch('/echo');
        expect(events).toEqual(['request:start', 'request:end']);
        await client.close();
    });

    it('流式响应体可正常读取', async () => {
        const client = new HttpClient({ baseURL: server.url });
        const res = await client.fetch('/binary');
        const reader = res.body!.getReader();
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done === true) break;
            received += value!.byteLength;
        }
        expect(received).toBe(256 * 1024);
        await client.close();
    });
});
