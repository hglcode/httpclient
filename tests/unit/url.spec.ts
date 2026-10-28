import { describe, expect, it } from 'vitest';
import { appendSearchParams, parseUrl, redactUrlForLog, resolveUrl } from '../../src/url.js';
import { InvalidUrlError } from '../../src/errors.js';

describe('resolveUrl', () => {
    it('绝对 URL 原样通过（带校验）', () => {
        expect(resolveUrl('https://api.example.com/v1', 'https://other.com/x')).toBe('https://other.com/x');
        expect(resolveUrl(undefined, 'http://a.com/b?c=1')).toBe('http://a.com/b?c=1');
        expect(resolveUrl('https://api.example.com', new URL('https://x.com/y'))).toBe('https://x.com/y');
    });

    it('绝对 URL 非法时抛 InvalidUrlError', () => {
        expect(() => resolveUrl(undefined, 'https://')).toThrow(InvalidUrlError);
        expect(() => resolveUrl(undefined, 'not a url')).toThrow(InvalidUrlError);
    });
    it('无 baseURL 且传相对路径 → InvalidUrlError', () => {
        expect(() => resolveUrl(undefined, 'users')).toThrow(InvalidUrlError);
        expect(() => resolveUrl('', '/users')).toThrow(InvalidUrlError);
    });

    it('以 / 开头 → 相对 origin（忽略 baseURL path）', () => {
        expect(resolveUrl('https://api.example.com/v1', '/users')).toBe('https://api.example.com/users');
        expect(resolveUrl('https://api.example.com/v1/', '/users')).toBe('https://api.example.com/users');
    });

    it('相对路径 → 拼接到 base（自动补尾斜杠）', () => {
        expect(resolveUrl('https://api.example.com', 'users')).toBe('https://api.example.com/users');
        expect(resolveUrl('https://api.example.com/v1', 'users')).toBe('https://api.example.com/v1/users');
        expect(resolveUrl('https://api.example.com/v1/', 'users')).toBe('https://api.example.com/v1/users');
        // . 与 .. 语义由 URL 标准处理
        expect(resolveUrl('https://api.example.com/v1/', './users')).toBe('https://api.example.com/v1/users');
    });

    it('baseURL 非法 → 构造期早失败', () => {
        expect(() => resolveUrl('::::', 'x')).toThrow(InvalidUrlError);
    });
});

describe('parseUrl', () => {
    it('合法 URL 返回 URL 实例', () => {
        expect(parseUrl('https://a.com/', 'url').hostname).toBe('a.com');
    });
    it('非法 URL 抛 InvalidUrlError 且保留 cause', () => {
        try {
            parseUrl('https://', 'url');
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(InvalidUrlError);
            expect((err as InvalidUrlError).cause).toBeDefined();
        }
    });
});

describe('appendSearchParams', () => {
    it('对象形式追加', () => {
        expect(appendSearchParams('https://a.com/x', { page: 2, size: 10 })).toBe('https://a.com/x?page=2&size=10');
    });
    it('URLSearchParams 形式', () => {
        expect(appendSearchParams('https://a.com/x', new URLSearchParams('a=1'))).toBe('https://a.com/x?a=1');
    });
    it('字符串形式', () => {
        expect(appendSearchParams('https://a.com/x', 'a=1&b=2')).toBe('https://a.com/x?a=1&b=2');
    });
    it('同名 key 替换而非叠加', () => {
        expect(appendSearchParams('https://a.com/x?b=1&b=2', { b: 3 })).toBe('https://a.com/x?b=3');
    });
    it('保留既有参数', () => {
        expect(appendSearchParams('https://a.com/x?keep=1', { add: 2 })).toBe('https://a.com/x?keep=1&add=2');
    });
});

describe('redactUrlForLog', () => {
    it('敏感 query 字段打码', () => {
        expect(redactUrlForLog('https://a.com/x?api_token=secret&ok=1')).toBe('https://a.com/x?api_token=%5BREDACTED%5D&ok=1');
    });
    it('无 query 或非法 URL 原样返回', () => {
        expect(redactUrlForLog('https://a.com/x')).toBe('https://a.com/x');
        expect(redactUrlForLog('not a url')).toBe('not a url');
    });
});
