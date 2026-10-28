/**
 * 请求头规范化与合并。
 *
 * 输出统一为「小写 key → string」的普通对象，与 undici fetch 在 dispatch
 * 层使用的 headers 形态一致（headersList.entries 为小写 key 对象）。
 */
import type { HeadersInit } from 'undici';

export type HeaderInput =
    | HeadersInit
    | Record<string, string>
    | [string, string][]
    | null
    | undefined;

/**
 * 与具体 Headers 实现解耦的最小结构接口。
 * 同时兼容全局 Headers（@types/node）与 undici Headers 两套类型声明，
 * 避免跨实现传递时的迭代器协议差异（TS7 的 Symbol.dispose 要求）。
 */
export interface HeadersLike {
    forEach(callback: (value: string, key: string) => void): void;
    getSetCookie(): string[];
}

/**
 * 鸭子类型判定 Headers 实例（而非 instanceof）：
 * undici Headers / 全局 Headers / Bun Headers 是不同的类，
 * instanceof 会漏判 undici Headers（其头会被静默丢弃）。
 */
function isHeadersLike(value: unknown): value is HeadersLike {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { forEach?: unknown }).forEach === 'function' &&
        typeof (value as { entries?: unknown }).entries === 'function'
    );
}

function isPairArray(value: unknown): value is [string, string][] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => Array.isArray(item) && item.length >= 2)
    );
}

/**
 * 头值收窄：仅接受 string / number / boolean 及其数组（数组逗号连接）。
 * 对象等复杂值返回 null（与其静默字符串化为 '[object Object]'，
 * 不如直接丢弃 —— 与 null/undefined 值的剔除哲学一致）。
 */
function toHeaderValue(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const allPrimitive = value.every(
            (item) =>
                typeof item === 'string' ||
                typeof item === 'number' ||
                typeof item === 'boolean',
        );
        return allPrimitive ? value.join(', ') : null;
    }
    return null;
}

export function normalizeHeaders(input: HeaderInput): Record<string, string> {
    const out: Record<string, string> = {};

    if (input == null) return out;

    if (isHeadersLike(input)) {
        input.forEach((value, key) => {
            out[key.toLowerCase()] = value;
        });
        return out;
    }

    if (isPairArray(input)) {
        for (const [key, value] of input) {
            if (typeof key === 'string' && typeof value === 'string') {
                out[key.toLowerCase()] = value;
            }
        }
        return out;
    }

    if (typeof input === 'object') {
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
            if (value == null) continue;
            const headerValue = toHeaderValue(value);
            if (headerValue == null) continue;
            out[key.toLowerCase()] = headerValue;
        }
        return out;
    }

    return out;
}

/** 后者优先（per-request 覆盖默认头） */
export function mergeHeaders(base: HeaderInput, override: HeaderInput): Record<string, string> {
    return { ...normalizeHeaders(base), ...normalizeHeaders(override) };
}

/** undici Response 的 Headers 快照为普通对象（set-cookie 保留数组） */
export function responseHeadersToRecord(headers: HeadersLike): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    headers.forEach((value, key) => {
        out[key] = value;
    });
    const setCookies = headers.getSetCookie();
    if (setCookies.length > 0) out['set-cookie'] = setCookies;
    return out;
}
