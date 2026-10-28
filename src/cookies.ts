/**
 * Cookie 会话装配：jar 构建（内存 / 文件 / 自定义 Store）与会话导入导出。
 *
 * 多实例隔离策略（对应用户选型）：每个 HttpClient 独立 jar + agent，
 * 文件模式下按 baseURL 哈希分文件，互不串扰；由 Registry 统一管理生命周期。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CookieJar, MemoryCookieStore } from 'tough-cookie';
import type { SerializedCookieJar } from 'tough-cookie';
import type { CookieOptions } from './types.js';
import { FileCookieStore } from './file-cookie-store.js';

export function createCookieJar(
    options: CookieOptions,
    baseURL: string,
): CookieJar {
    if (options.store != null) {
        return new CookieJar(options.store);
    }
    if (options.dir != null) {
        const hash = createHash('sha256').update(baseURL).digest('hex').slice(0, 16);
        const prefix = options.filePrefix ?? 'cookies';
        const file = join(options.dir, `${prefix}-${hash}.json`);
        return new CookieJar(new FileCookieStore(file, { debounceMs: options.persistDebounceMs }));
    }
    return new CookieJar(new MemoryCookieStore());
}

/**
 * 导出会话（tough-cookie 序列化格式，可入库/传递）。
 * serializeSync 理论上可能返回 undefined，统一归一化为 null。
 */
export function exportCookies(jar: CookieJar): SerializedCookieJar | null {
    try {
        return jar.serializeSync() ?? null;
    } catch {
        return null;
    }
}

/** 从序列化数据恢复会话 */
export function importCookies(data: unknown): CookieJar {
    return CookieJar.deserializeSync(data as Parameters<typeof CookieJar.deserializeSync>[0]);
}

export type { SerializedCookieJar };

/** 优雅落盘（仅文件 Store 有实际动作），client.close() 时调用 */
export function flushCookieStore(jar: CookieJar): void {
    const store: unknown = jar.store;
    if (store instanceof FileCookieStore) {
        store.flushSync();
    }
}
