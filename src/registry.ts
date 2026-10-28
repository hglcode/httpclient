/**
 * 多实例注册表：按 baseURL 隔离的 client 生命周期管理。
 *
 * 典型用法：一个外部依赖（下游服务）一个 HttpClient，
 * 各自独立的连接池 / cookie 会话 / 熔断状态 / 限流预算，
 * 进程退出时统一优雅关闭。
 */
import { HttpClient } from './client.js';
import type { HttpClientOptions } from './types.js';

export class HttpClientRegistry {
    readonly #clients = new Map<string, HttpClient>();
    readonly #baseOptions: HttpClientOptions;

    constructor(baseOptions: HttpClientOptions = {}) {
        this.#baseOptions = baseOptions;
    }

    /**
     * 获取（或创建）指定 baseURL 的 client。
     * 注意：overrides 仅在**首次创建**时生效；已存在的实例直接复用
     * （保持单例语义，避免同一 baseURL 出现两套连接池）。
     */
    get(baseURL: string, overrides: HttpClientOptions = {}): HttpClient {
        const existing = this.#clients.get(baseURL);
        if (existing != null) return existing;

        const client = new HttpClient({ ...this.#baseOptions, ...overrides, baseURL });
        this.#clients.set(baseURL, client);
        return client;
    }

    has(baseURL: string): boolean {
        return this.#clients.has(baseURL);
    }

    /** 关闭并移除单个 client */
    async remove(baseURL: string): Promise<boolean> {
        const client = this.#clients.get(baseURL);
        if (client == null) return false;
        this.#clients.delete(baseURL);
        await client.close();
        return true;
    }

    list(): string[] {
        return [...this.#clients.keys()];
    }

    get size(): number {
        return this.#clients.size;
    }

    /** 全部优雅关闭（等待在途请求完成、cookie 落盘） */
    async close(): Promise<void> {
        const clients = [...this.#clients.values()];
        this.#clients.clear();
        await Promise.allSettled(clients.map((client) => client.close()));
    }

    /** 全部强制关闭 */
    async destroy(): Promise<void> {
        const clients = [...this.#clients.values()];
        this.#clients.clear();
        await Promise.allSettled(clients.map((client) => client.destroy()));
    }
}

export function createHttpClientRegistry(baseOptions?: HttpClientOptions): HttpClientRegistry {
    return new HttpClientRegistry(baseOptions);
}
