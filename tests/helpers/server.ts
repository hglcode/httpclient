/**
 * 集成测试共享：可编程的本地 HTTP server。
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { hits: Map<string, number> },
) => void | Promise<void>;

export interface TestServer {
    url: string;
    close(): Promise<void>;
    hits(path: string): number;
    totalHits(): number;
}

export async function startServer(handler: Handler): Promise<TestServer> {
    const hits = new Map<string, number>();

    const server = http.createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        hits.set(path, (hits.get(path) ?? 0) + 1);
        void Promise.resolve(handler(req, res, { hits })).catch((err) => {
            if (!res.headersSent) {
                res.statusCode = 500;
            }
            res.end(`server error: ${String(err)}`);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address == null || typeof address === 'string') {
        throw new Error('failed to start test server');
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        async close(): Promise<void> {
            server.closeAllConnections?.();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err == null) {
                        resolve();
                        return;
                    }
                    // Bun 兼容：其 closeAllConnections() 会顺带置空 server handle，
                    // 随后的 close() 报 ERR_SERVER_NOT_RUNNING —— 语义上已是关闭状态
                    if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
                        resolve();
                        return;
                    }
                    reject(err);
                });
            });
        },
        hits(path: string): number {
            return hits.get(path) ?? 0;
        },
        totalHits(): number {
            let sum = 0;
            for (const n of hits.values()) sum += n;
            return sum;
        },
    };
}

export function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
