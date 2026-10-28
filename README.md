# undici-http-client

生产级 fetch 风格 HTTP 客户端，基于 undici 构建。**稳定优先，简洁为纲** —— 零隐式行为，所有能力显式可配。

```ts
import { createHttpClient } from './src/index.js';

const client = createHttpClient({
    baseURL: 'https://api.example.com/v1',
    timeout: 10_000,
    retry: { maxRetries: 3 },
    cookies: { dir: './data/cookies' },        // 会话持久化
    rateLimit: { maxConcurrent: 8, requestsPerSecond: 50 },
    telemetry: { logger: console },
});

const res = await client.fetch('/users', { searchParams: { page: 2 } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const users = await res.json();

await client.close(); // 优雅关闭：等待在途请求、cookie 落盘
```

## 能力总览

| 能力 | 说明 | 默认 |
|------|------|------|
| **fetch 语义** | 单一 `client.fetch(url, init)`，返回标准 `Response`（`res.ok` / `res.json()` / `res.body`） | — |
| **Cookie 会话** | 自动注入/收集，RFC6265 全语义（域/路径/过期/Secure），多实例天然隔离 | 内存 jar |
| **文件持久化** | `cookies: { dir }` 启用，原子写 + 去抖落盘，`close()` 强制 flush | 关闭 |
| **重试退避** | 指数退避 + half/full jitter，遵循 `Retry-After`，幂等方法白名单，流式 body 自动降级单次 | 开启（2 次） |
| **熔断器** | 滑动窗口失败率三态机（closed/open/half-open），只统计真实到达网络的请求 | 开启 |
| **限流并发** | 每实例并发上限 + 令牌桶 QPS，超限排队 / 快速失败 | 关闭 |
| **遥测** | 结构化事件总线 + 内置统计（P50/P95/P99、重试数、状态码分布）+ 日志桥接 | 统计开启，日志静默 |
| **类型化错误树** | `NetworkError` / `TimeoutError` / `RequestAbortedError` / `CircuitOpenError` / `RateLimitRejectedError` / `HttpError`，均携带稳定 `code` 与 `retryable` 元数据 | — |
| **多实例管理** | `HttpClientRegistry` 按 baseURL 隔离，统一优雅关闭 | — |
| **双运行时** | Node（undici dispatcher 拦截链）与 Bun（client 层等价路径）自动切换，行为一致 | 自动 |

## 安装

```bash
# Node.js >= 22.19
npm install undici tough-cookie
```

## 运行时兼容性（Node / Bun）

库在构造期做一次能力探测（`supportsUndiciDispatcher()`），自动选择传输路径：

| 运行时 | 路径 | 说明 |
|--------|------|------|
| **Node 22.19+** | undici `Agent` + dispatcher 拦截链 | 完整能力，含 `agent` 连接池调优 |
| **Bun 1.x+** | 全局 fetch + client 层等价拦截链 | 重试/熔断/限流/cookie（含重定向逐跳）全语义保留 |

> **背景**：Bun 将 `undici` 说明符解析到内置空壳（`Agent`/`Dispatcher` 无任何实例方法，且缺少 undici 8 所需的 `util.markAsUncloneable`），因此 dispatcher 子系统在 Bun 下不可用 —— 与安装的 undici 版本无关。本库在 client 层等价实现拦截链，而非放弃功能。

```ts
const client = createHttpClient({ baseURL: 'https://api.example.com' });
console.log(client.dispatcherMode); // Node: true（dispatcher 链）；Bun: false（全局 fetch 路径）
```

Bun 路径的已知边界：

- `agent` 连接池调优选项不生效（Bun fetch 自管连接池）；
- 熔断在响应头到达时记账（Node 路径在响应体完结时）；
- 307/308 携带流式 body 时不自动跟随重定向（返回 3xx 由调用方决策，与 undici fetch 对流 body 的行为一致）。

测试双运行时等价：`npm test`（Node/vitest）与 `bun test` 跑同一套 164 个用例，均全绿。

## 快速上手

### 基本请求

```ts
const client = createHttpClient({ baseURL: 'https://api.example.com' });

// GET（fetch 语义：非 2xx 不抛错）
const res = await client.fetch('/users/42');
console.log(res.status, res.ok);

// POST + JSON 快捷方式（自动序列化 + content-type）
const created = await client.fetch('/users', {
    method: 'POST',
    json: { name: 'alice' },
});

// 查询参数
const list = await client.fetch('/users', {
    searchParams: { page: 1, size: 20 },
});

// 非 2xx 抛 HttpError（携带 body/headers 快照）
await client.fetch('/missing', { throwOnHttpError: true });
```

### 重试

```ts
const client = createHttpClient({
    retry: {
        maxRetries: 3,           // 首次 + 3 次重试
        initialDelayMs: 200,     // 200 → 400 → 800...
        backoffFactor: 2,
        maxDelayMs: 30_000,
        jitter: 'half',          // half | full | none
        retryOnStatus: [408, 425, 429, 500, 502, 503, 504],
        methods: ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE'],
        respectRetryAfter: true, // 遵循 Retry-After（秒/HTTP-date），封顶 maxDelayMs
        canRetry: (d) => d.status !== 503 || d.nextAttempt <= 2, // 自定义裁决
    },
});

// 单请求关闭重试
await client.fetch('/one-shot', { retry: false });
```

**安全边界**：流式 body（`ReadableStream` / `Readable` / `AsyncIterable`）不可重放，此类请求自动降级为单次发送；POST 默认不重试（加入 `methods` 白名单或提供 `canRetry` 钩子开启）。

### 熔断器

```ts
const client = createHttpClient({
    circuitBreaker: {
        windowDurationMs: 10_000,   // 滑动窗口
        minimumVolume: 10,          // 窗口内最少样本量才评估
        failureRateThreshold: 0.5,  // 失败率 ≥ 50% → 熔断
        openDurationMs: 30_000,     // 熔断保持 → 半开探测
        halfOpenMaxProbes: 5,       // 半开并发探测上限
        halfOpenSuccessThreshold: 3,// 成功数达标 → 恢复
        failureStatusCodes: [500, 502, 503, 504], // 计入失败的响应码
    },
});

client.circuitBreakerSnapshot; // { state, volume, failures, failureRate, retryInMs }
```

熔断打开时请求立即以 `CircuitOpenError` 失败（`retryable: false`，不消耗重试预算）。传输错误（连接拒绝/重置/超时）总是计入失败；4xx 视为业务语义不计入。

### 限流与并发

```ts
const client = createHttpClient({
    rateLimit: {
        maxConcurrent: 8,        // 单实例并发上限（超出排队 FIFO）
        requestsPerSecond: 50,   // 令牌桶限速
        burst: 50,               // 令牌容量（突发），默认 ceil(rps)
        queueLimit: 100,         // 排队上限，超出 → RateLimitRejectedError('queue-full')
        queueTimeoutMs: 60_000,  // 排队超时 → RateLimitRejectedError('queue-timeout')
    },
});
```

限流**默认关闭** —— 不制造隐式行为，按需开启。

### Cookie 会话与持久化

```ts
// 内存（默认）：进程内保持登录态
const client = createHttpClient({ baseURL: 'https://example.com' });
await client.fetch('/login', { method: 'POST', json: { user, pass } });
await client.fetch('/dashboard'); // 自动携带会话 cookie

// 文件持久化：重启保活（按 baseURL 哈希分文件，多实例互不串扰）
const persisted = createHttpClient({
    baseURL: 'https://example.com',
    cookies: { dir: './data/cookies', persistDebounceMs: 500 },
});
await persisted.close(); // 优雅落盘

// 会话导出/导入（跨实例迁移，如热更新）
const session = client.exportSession();
const revived = createHttpClient({
    cookies: { store: importCookies(session).store },
});

// 显式 Cookie 头优先于 jar（不隐式合并）
await client.fetch('/x', { headers: { cookie: 'manual=1' } });
```

自定义存储：实现 tough-cookie `Store` 接口（如 Redis）后通过 `cookies.store` 注入。

### 遥测与统计

```ts
const client = createHttpClient({
    telemetry: {
        logger: myLogger,          // pino/winston/自研均可（最小 debug/info/warn/error 接口）
        logLevel: 'info',          // 常规成功(debug)静默，5xx/错误可见
        onEvent: (e) => {          // 结构化事件 → APM/OTel 桥接
            if (e.type === 'request:end') metrics.record(e);
        },
    },
});

client.stats;
// {
//   inFlight, totalRequests, totalRetries, totalErrors,
//   statusCounts: { '2xx': n, '5xx': n, ... },
//   duration: { count, minMs, maxMs, p50, p95, p99 },
//   circuitBreaker: {...}, rateLimit: { active, queued, availableTokens }
// }
```

事件类型：`request:start`（每次尝试）/ `request:end` / `retry:scheduled` / `circuit-breaker:state-change`。

### 多实例注册表

```ts
const registry = createHttpClientRegistry({
    retry: { maxRetries: 2 },
    timeout: 5000,
});

const github = registry.get('https://api.github.com');       // 独立连接池/cookie/熔断
const stripe = registry.get('https://api.stripe.com', {      // overrides 仅首次创建生效
    headers: { authorization: `Bearer ${key}` },
});

await registry.close(); // 统一优雅关闭
```

## 错误处理

```ts
import {
    HttpError, NetworkError, TimeoutError, RequestAbortedError,
    CircuitOpenError, RateLimitRejectedError, isRetryableError, ERROR_CODES,
} from './src/index.js';

try {
    await client.fetch('/flaky', { throwOnHttpError: true });
} catch (err) {
    if (err instanceof HttpError) {
        err.status; err.headers; err.body;   // 响应快照（body ≤ 64KB）
    } else if (err instanceof TimeoutError) {
        err.kind; // 'connect' | 'headers' | 'body' | 'total' | 'queue'
    } else if (err instanceof CircuitOpenError) {
        err.retryInMs;                       // 距半开的建议等待
    }
    isRetryableError(err); // 布尔判定
    err.code;              // 稳定错误码，如 'HTTP_CLIENT_TIMEOUT'
}
```

所有错误保留 `Error.cause` 链直达底层 socket 错误；undici fetch 的 `TypeError: fetch failed` 包装会被自动解包归一化。

## 超时与中止

```ts
// 构造器默认 + 请求级覆盖；每次重试获得独立的新鲜超时预算
await client.fetch('/slow', { timeout: 3000 });

// AbortSignal 原生支持（包括重试退避期间 —— 立即中止，不再继续重试）
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);
await client.fetch('/slow', { signal: controller.signal });
```

## 从旧版 HttpClient 迁移

| 旧 API | 新 API |
|--------|--------|
| `client.get/post/put/patch/delete(url, opts)` | `client.fetch(url, { method: 'POST', ... })` |
| `opts.maxRedirects` | fetch 原生 `redirect: 'follow' \| 'manual'`（默认 follow） |
| `opts.throwErrors` | `init.throwOnHttpError` |
| 构造器 `timeout` | 同名保留 |
| `HttpError` | 保留，字段更全（含 statusText/headers） |
| `http-cookie-agent` 依赖 | 内置 cookie 拦截器，无需该依赖 |
| `combineSignals` 手动实现 | Node 22+ 原生 `AbortSignal.any` |

## 开发

```bash
npm test          # 全量测试（单元 + 集成，真实本地 server）— Node / dispatcher 路径
bun test          # 同一套用例在 Bun 下运行 — 全局 fetch 等价路径
npm run typecheck # tsc --noEmit（strict，TypeScript 7）
npm run build     # 产出 dist/
```

## 目录结构

```
src/
├── client.ts                    # HttpClient：fetch 主循环（重试/超时/中止/遥测）
├── errors.ts                    # 类型化错误树 + 归一化
├── retry.ts                     # 退避/Retry-After/可重放判定
├── headers.ts / url.ts          # 头合并 / URL 解析
├── cookies.ts                   # jar 装配 + 会话导入导出
├── file-cookie-store.ts         # 文件持久化 Store（原子写+去抖）
├── telemetry.ts                 # 事件总线 + 统计 + 日志桥接
├── registry.ts                  # 多实例注册表
├── types.ts                     # 公共类型
└── interceptors/
    ├── utils.ts                 # undici 拦截器契约 + BaseDispatchHandler
    ├── cookie-interceptor.ts    # Cookie 注入/收集
    ├── circuit-breaker.ts       # 熔断状态机 + 拦截器
    └── rate-limit.ts            # 并发/令牌桶限流器 + 拦截器
```

架构决策、拦截链顺序依据、已知边界见 [DESIGN.md](./DESIGN.md)。
