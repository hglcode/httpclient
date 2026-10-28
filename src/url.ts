/**
 * URL 解析与拼接。
 *
 * 语义（与常见 baseURL 约定一致）：
 * - 绝对 URL（scheme://…）：原样使用；
 * - 以 `/` 开头：相对 origin（忽略 baseURL 的 path 部分）；
 * - 其他相对路径：拼接到 baseURL（自动补尾部斜杠，避免 'v1'+'users' 语义歧义）；
 * - baseURL 未设置且传入相对路径 → InvalidUrlError（尽早失败）。
 */
import { InvalidUrlError } from './errors.js';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 校验并解析 URL，失败抛 InvalidUrlError */
export function parseUrl(url: string, what: string): URL {
    try {
        return new URL(url);
    } catch (cause) {
        throw new InvalidUrlError(`Invalid ${what}: "${url}"`, cause);
    }
}

/** 构造期校验 baseURL（早失败，避免请求期才暴露配置错误） */
export function assertBaseUrl(baseURL: string | undefined): void {
    if (baseURL === undefined || baseURL === '') return;
    parseUrl(baseURL, 'baseURL');
}

export function resolveUrl(baseURL: string | undefined, input: string | URL): string {
    const inputStr = typeof input === 'string' ? input : input.toString();

    if (ABSOLUTE_URL_PATTERN.test(inputStr)) {
        return parseUrl(inputStr, 'request URL').toString();
    }

    if (baseURL === undefined || baseURL === '') {
        throw new InvalidUrlError(
            `Cannot resolve relative URL "${inputStr}" because baseURL is not set. ` +
                'Pass an absolute URL or configure baseURL on the client.',
        );
    }

    const base = parseUrl(baseURL, 'baseURL');

    // 以 / 开头 → 相对 origin
    if (inputStr.startsWith('/')) {
        return new URL(inputStr, base).toString();
    }

    const normalizedBase = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
    return new URL(inputStr, normalizedBase).toString();
}

/**
 * 追加查询参数。同名 key 采用「替换」语义（可预期，避免重复参数）。
 * 支持 URLSearchParams / 普通对象 / 'a=1&b=2' 字符串。
 */
export function appendSearchParams(
    url: string,
    searchParams: URLSearchParams | Record<string, string | number | boolean> | string,
): string {
    const parsed = parseUrl(url, 'request URL');
    const params =
        searchParams instanceof URLSearchParams
            ? searchParams
            : typeof searchParams === 'string'
              ? new URLSearchParams(searchParams)
              : new URLSearchParams(
                    Object.entries(searchParams).map(
                        ([key, value]) => [key, String(value)] as [string, string],
                    ),
                );
    for (const [key, value] of params) {
        parsed.searchParams.set(key, value);
    }
    return parsed.toString();
}

/** 规范化 URL 用于日志展示（抹去 query 中可能的敏感字段） */
export function redactUrlForLog(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.searchParams.size === 0) return parsed.toString();
        for (const key of parsed.searchParams.keys()) {
            if (/token|secret|password|key|signature|authorization/i.test(key)) {
                parsed.searchParams.set(key, '[REDACTED]');
            }
        }
        return parsed.toString();
    } catch {
        return url;
    }
}
