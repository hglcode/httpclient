/**
 * FileCookieStore：基于文件的 tough-cookie Store。
 *
 * 策略（稳定性优先，见 DESIGN.md 决策 #5）：
 * - 继承 MemoryCookieStore（内存语义，synchronous=true，性能与行为完全一致）；
 * - 启动时同步加载一次；此后所有读写走内存；
 * - 变更后去抖落盘（原子写：tmp + rename），进程退出前由 client.close() flushSync；
 * - 文件损坏时重命名为 *.corrupt 并从空库启动 —— 持久化失败不应阻断请求。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cookie, MemoryCookieStore } from 'tough-cookie';
import type { Cookie as CookieType, ErrorCallback } from 'tough-cookie';

interface FileCookieStoreOptions {
    /** 写盘去抖 ms。默认 500 */
    debounceMs?: number;
}

interface PersistedShape {
    version: 1;
    cookies: unknown[];
}

export class FileCookieStore extends MemoryCookieStore {
    readonly #filePath: string;
    readonly #debounceMs: number;
    #flushTimer: ReturnType<typeof setTimeout> | null = null;
    #dirty = false;

    constructor(filePath: string, options: FileCookieStoreOptions = {}) {
        super();
        this.#filePath = filePath;
        this.#debounceMs = options.debounceMs ?? 500;
        this.#load();
    }

    override putCookie(cookie: CookieType): Promise<void>;
    override putCookie(cookie: CookieType, callback: ErrorCallback): void;
    override putCookie(cookie: CookieType, callback?: ErrorCallback): Promise<void> | void {
        if (callback === undefined) {
            return new Promise<void>((resolve, reject) => {
                super.putCookie(cookie, (err) => (err == null ? resolve() : reject(err)));
                this.#schedulePersist();
            });
        }
        super.putCookie(cookie, callback);
        this.#schedulePersist();
    }

    override updateCookie(oldCookie: CookieType, newCookie: CookieType): Promise<void>;
    override updateCookie(oldCookie: CookieType, newCookie: CookieType, callback: ErrorCallback): void;
    override updateCookie(
        oldCookie: CookieType,
        newCookie: CookieType,
        callback?: ErrorCallback,
    ): Promise<void> | void {
        if (callback === undefined) {
            return new Promise<void>((resolve, reject) => {
                super.updateCookie(oldCookie, newCookie, (err) => (err == null ? resolve() : reject(err)));
                this.#schedulePersist();
            });
        }
        super.updateCookie(oldCookie, newCookie, callback);
        this.#schedulePersist();
    }

    override removeCookie(domain: string, path: string, key: string): Promise<void>;
    override removeCookie(domain: string, path: string, key: string, callback: ErrorCallback): void;
    override removeCookie(
        domain: string,
        path: string,
        key: string,
        callback?: ErrorCallback,
    ): Promise<void> | void {
        if (callback === undefined) {
            return new Promise<void>((resolve, reject) => {
                super.removeCookie(domain, path, key, (err) => (err == null ? resolve() : reject(err)));
                this.#schedulePersist();
            });
        }
        super.removeCookie(domain, path, key, callback);
        this.#schedulePersist();
    }

    override removeCookies(domain: string, path: string): Promise<void>;
    override removeCookies(domain: string, path: string, callback: ErrorCallback): void;
    override removeCookies(domain: string, path: string, callback?: ErrorCallback): Promise<void> | void {
        if (callback === undefined) {
            return new Promise<void>((resolve, reject) => {
                super.removeCookies(domain, path, (err) => (err == null ? resolve() : reject(err)));
                this.#schedulePersist();
            });
        }
        super.removeCookies(domain, path, callback);
        this.#schedulePersist();
    }

    override removeAllCookies(): Promise<void>;
    override removeAllCookies(callback: ErrorCallback): void;
    override removeAllCookies(callback?: ErrorCallback): Promise<void> | void {
        if (callback === undefined) {
            return new Promise<void>((resolve, reject) => {
                super.removeAllCookies((err) => (err == null ? resolve() : reject(err)));
                this.#schedulePersist();
            });
        }
        super.removeAllCookies(callback);
        this.#schedulePersist();
    }

    /** 立即同步落盘（client.close() 调用，保证优雅关闭不丢数据） */
    flushSync(): void {
        if (this.#flushTimer != null) {
            clearTimeout(this.#flushTimer);
            this.#flushTimer = null;
        }
        if (!this.#dirty) return;
        this.#dirty = false;

        let cookies: unknown[] = [];
        // MemoryCookieStore 回调为同步触发（synchronous store）
        super.getAllCookies((error, all) => {
            if (error == null && Array.isArray(all)) {
                cookies = all.map((cookie) => cookie.toJSON());
            }
        });

        const payload: PersistedShape = { version: 1, cookies };
        try {
            mkdirSync(dirname(this.#filePath), { recursive: true });
            const tmpPath = `${this.#filePath}.${process.pid}.tmp`;
            writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
            renameSync(tmpPath, this.#filePath);
        } catch {
            this.#dirty = true; // 写失败：保留脏标记，下次变更重试
        }
    }

    #load(): void {
        let raw: string;
        try {
            raw = readFileSync(this.#filePath, 'utf8');
        } catch {
            return; // 文件不存在 → 空库启动
        }

        try {
            const parsed = JSON.parse(raw) as PersistedShape;
            if (parsed == null || parsed.version !== 1 || !Array.isArray(parsed.cookies)) {
                throw new Error('unexpected file shape');
            }
            for (const item of parsed.cookies) {
                const cookie = Cookie.fromJSON(item);
                if (cookie == null) continue;
                const expiry = cookie.expiryTime();
                if (typeof expiry === 'number' && Number.isFinite(expiry) && expiry < Date.now()) {
                    continue; // 跳过已过期
                }
                super.putCookie(cookie, () => {});
            }
        } catch {
            // 损坏文件：隔离后从空库启动
            try {
                renameSync(this.#filePath, `${this.#filePath}.corrupt`);
            } catch {
                /* 隔离失败也继续运行 */
            }
        }
    }

    #schedulePersist(): void {
        this.#dirty = true;
        if (this.#flushTimer != null) return;
        this.#flushTimer = setTimeout(() => {
            this.#flushTimer = null;
            this.flushSync();
        }, this.#debounceMs);
        this.#flushTimer.unref?.(); // 不阻止进程退出
    }
}
