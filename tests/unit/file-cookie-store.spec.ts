import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCookieStore } from '../../src/file-cookie-store.js';
import { Cookie, CookieJar } from 'tough-cookie';

let dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-test-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

function makeCookie(key: string, value: string, domain = 'example.com'): Cookie {
    const cookie = new Cookie({ key, value, domain, path: '/' });
    return cookie;
}

describe('FileCookieStore', () => {
    it('put 后 flushSync 落盘，可跨实例加载', () => {
        const dir = tempDir();
        const file = join(dir, 'cookies.json');
        const store = new FileCookieStore(file, { debounceMs: 1000 });
        const jar = new CookieJar(store);

        jar.setCookieSync('session=abc; Domain=example.com; Path=/', 'https://example.com/');
        store.flushSync();

        expect(existsSync(file)).toBe(true);
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; cookies: unknown[] };
        expect(raw.version).toBe(1);
        expect(raw.cookies.length).toBe(1);

        // 新实例从文件恢复
        const store2 = new FileCookieStore(file);
        const jar2 = new CookieJar(store2);
        expect(jar2.getCookieStringSync('https://example.com/')).toBe('session=abc');
    });

    it('去抖写入：变更后自动落盘（不等 flushSync）', async () => {
        const dir = tempDir();
        const file = join(dir, 'cookies.json');
        const store = new FileCookieStore(file, { debounceMs: 50 });
        const jar = new CookieJar(store);
        jar.setCookieSync('a=1; Domain=example.com; Path=/', 'https://example.com/');

        expect(existsSync(file)).toBe(false); // 未到期
        await new Promise((r) => setTimeout(r, 150));
        expect(existsSync(file)).toBe(true);
    });

    it('会话 cookie（无 expires）同样持久化（进程重启保活策略）', () => {
        const dir = tempDir();
        const file = join(dir, 'cookies.json');
        const store = new FileCookieStore(file, { debounceMs: 10_000 });
        const jar = new CookieJar(store);
        jar.setCookieSync('sess=temp; Domain=example.com; Path=/', 'https://example.com/');
        store.flushSync();

        const jar2 = new CookieJar(new FileCookieStore(file));
        expect(jar2.getCookieStringSync('https://example.com/')).toBe('sess=temp');
    });

    it('加载时跳过已过期 cookie', () => {
        const dir = tempDir();
        const file = join(dir, 'cookies.json');
        // 注意：cookie 日期必须用 RFC1123（toUTCString），ISO 格式会被当作会话 cookie
        const past = new Date(Date.now() - 10_000).toUTCString();
        const future = new Date(Date.now() + 60_000).toUTCString();
        const store = new FileCookieStore(file);
        const jar = new CookieJar(store);
        jar.setCookieSync(`old=1; Domain=example.com; Path=/; Expires=${past}`, 'https://example.com/');
        jar.setCookieSync(`fresh=2; Domain=example.com; Path=/; Expires=${future}`, 'https://example.com/');
        store.flushSync();

        const jar2 = new CookieJar(new FileCookieStore(file));
        const cookies = jar2.getCookieStringSync('https://example.com/');
        expect(cookies).toBe('fresh=2');
    });

    it('损坏文件 → 隔离为 .corrupt 并空库启动', () => {
        const dir = tempDir();
        const file = join(dir, 'cookies.json');
        writeFileSync(file, '{ not valid json !!', 'utf8');

        const store = new FileCookieStore(file);
        const jar = new CookieJar(store);
        expect(jar.getCookieStringSync('https://example.com/')).toBe('');
        expect(existsSync(`${file}.corrupt`)).toBe(true);
    });

    it('直接使用 Store API（putCookie/updateCookie/removeCookie）', async () => {
        const dir = tempDir();
        const file = join(dir, 'cookies.json');
        const store = new FileCookieStore(file, { debounceMs: 10_000 });

        await store.putCookie(makeCookie('a', '1'));
        await store.updateCookie(makeCookie('a', '1'), makeCookie('a', '2'));
        store.flushSync();

        const jar2 = new CookieJar(new FileCookieStore(file));
        expect(jar2.getCookieStringSync('https://example.com/')).toBe('a=2');

        await store.removeCookie('example.com', '/', 'a');
        store.flushSync();
        const jar3 = new CookieJar(new FileCookieStore(file));
        expect(jar3.getCookieStringSync('https://example.com/')).toBe('');
    });

    it('文件不存在时空库启动', () => {
        const dir = tempDir();
        const store = new FileCookieStore(join(dir, 'missing.json'));
        const jar = new CookieJar(store);
        expect(jar.getCookieStringSync('https://example.com/')).toBe('');
    });
});
