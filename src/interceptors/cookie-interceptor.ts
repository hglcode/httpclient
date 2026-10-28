/**
 * Cookie 拦截器：请求侧自动注入 Cookie 头，响应侧收集 Set-Cookie 入 jar。
 *
 * 自研实现（而非 http-cookie-agent）的决策见 DESIGN.md 决策 #3：
 * - 零第三方依赖、不受 undici 大版本 peer 依赖约束；
 * - 走标准 undici interceptor 契约，任何 Agent/ProxyAgent 均可组合；
 * - tough-cookie 负责全部 RFC6265 语义（域/路径/过期/Secure）。
 *
 * 行为约定：
 * - 调用方显式设置了 Cookie 头 → 完全尊重，不做注入（可预期、不隐式合并）；
 * - fetch 层的每次重定向 hop 都会重新经过 dispatch → 逐跳正确处理 Set-Cookie；
 * - 无效 Set-Cookie 忽略（单条坏 cookie 不应拖垮整个响应）。
 */
import type { CookieJar } from 'tough-cookie';
import type { DispatchController, DispatchHandler, DispatchOpts, UndiciInterceptor } from './utils.js';
import { BaseDispatchHandler } from './utils.js';

type HeadersLike = Record<string, string | string[] | undefined>;

/** 响应侧：收集 Set-Cookie 并写入 jar */
class CookieResponseHandler extends BaseDispatchHandler {
    readonly #jar: CookieJar;
    readonly #url: string;

    constructor(jar: CookieJar, url: string, handler: DispatchHandler) {
        super(handler);
        this.#jar = jar;
        this.#url = url;
    }

    override onResponseStart(
        controller: DispatchController,
        statusCode: number,
        headers: HeadersLike,
        statusMessage: string | undefined,
    ): boolean | void {
        try {
            storeSetCookies(headers, this.#url, this.#jar);
        } catch {
            // cookie 处理失败绝不影响响应本体
        }
        return super.onResponseStart(controller, statusCode, headers, statusMessage);
    }
}

function storeSetCookies(headers: HeadersLike, url: string, jar: CookieJar): void {
    const raw: string | string[] | undefined = headers['set-cookie'];
    if (raw == null) return;
    const cookies = Array.isArray(raw) ? raw : [raw];
    for (const cookie of cookies) {
        if (typeof cookie !== 'string' || cookie === '') continue;
        try {
            jar.setCookieSync(cookie, url, { http: true });
        } catch {
            // 无效 cookie（如非法属性）安全忽略
        }
    }
}

/* ---------------------- 请求侧 Cookie 注入 ---------------------- */

function headerEntries(headers: unknown): Array<[string, unknown]> | null {
    if (headers == null) return [];
    if (Array.isArray(headers)) {
        // [k, v][] 形式
        if (headers.length > 0 && Array.isArray(headers[0])) {
            return (headers as unknown[][]).map((pair) => [String(pair[0]), pair[1]] as [string, unknown]);
        }
        // 扁平 [k, v, k, v] 形式
        const out: Array<[string, unknown]> = [];
        for (let i = 0; i + 1 < headers.length; i += 2) {
            out.push([String(headers[i]), headers[i + 1]]);
        }
        return out;
    }
    if (typeof headers === 'object') {
        return Object.entries(headers as Record<string, unknown>);
    }
    return null; // 字符串形式（CRLF 拼接），无法安全判断/注入
}

function hasCookieHeader(headers: unknown): boolean {
    const entries = headerEntries(headers);
    if (entries == null) return false;
    return entries.some(([key]) => key.toLowerCase() === 'cookie');
}

function withCookieHeader(
    headers: DispatchOpts['headers'],
    cookie: string,
): DispatchOpts['headers'] {
    if (headers == null) return { cookie };
    if (Array.isArray(headers)) {
        if (headers.length > 0 && Array.isArray(headers[0])) {
            return [...(headers as unknown as [string, string][]), ['cookie', cookie]];
        }
        return [...(headers as unknown as unknown[]), 'cookie', cookie] as DispatchOpts['headers'];
    }
    return { ...(headers as Record<string, string>), cookie };
}

/**
 * 创建 cookie 拦截器。
 * 组合位置：最贴近 Agent（内层），使外层的熔断/限流失败不产生多余的 jar 操作。
 */
export function cookieInterceptor(jar: CookieJar): UndiciInterceptor {
    return (dispatch) => (opts, handler) => {
        const origin = opts.origin;
        // 无 origin（理论上不会发生）时直接透传
        if (origin == null) {
            return dispatch(opts, new CookieResponseHandler(jar, 'about:blank', handler));
        }

        const originStr = origin instanceof URL ? origin.toString() : String(origin);
        // 去掉尾斜杠，避免 'https://x.com/' + '/path' 变成双斜杠
        const base = originStr.endsWith('/') ? originStr.slice(0, -1) : originStr;
        const url = `${base}${opts.path}`;

        if (hasCookieHeader(opts.headers)) {
            return dispatch(opts, new CookieResponseHandler(jar, url, handler));
        }

        let cookie = '';
        try {
            cookie = jar.getCookieStringSync(url);
        } catch {
            cookie = '';
        }

        if (cookie === '') {
            return dispatch(opts, new CookieResponseHandler(jar, url, handler));
        }

        return dispatch(
            { ...opts, headers: withCookieHeader(opts.headers, cookie) },
            new CookieResponseHandler(jar, url, handler),
        );
    };
}
