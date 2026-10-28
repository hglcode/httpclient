# 架构设计文档 — httpclient

> 版本 1.0 · 目标运行时 Node.js ≥ 22 · 依赖仅 `undici` + `tough-cookie`
>
> 设计基调：**稳定 + 简洁，拒绝过度设计**。每个组件都回答同一个问题：
> 「生产事故时，这块行为是否可预测？」

## 1. 目标与非目标

**目标**

- fetch 语义（单一入口、标准 Response、非 2xx 默认不抛错），降低团队认知成本
- 传输层健壮性：重试/熔断/限流三者正交组合，语义互不污染
- 会话管理：per-baseURL 隔离 + 可选文件持久化 + 优雅关闭
- 全链路可观测：结构化事件 + 有界内存统计 + 可桥接任意日志实现
- 错误可编程：稳定 code + retryable 元数据 + cause 链

**非目标（刻意不做）**

- 浏览器/边缘运行时兼容（undici 是 Node 专属）
- 自建洋葱模型中间件体系（undici interceptor 契约已足够，见决策 #1）
- 响应缓存 / HTTP/2 / SOCKS 代理（undici 官方 interceptor/Agent 已覆盖，可按需组合）
- OpenTelemetry 强绑定（通过事件总线解耦，桥接由使用方实现）

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  client 层（src/client.ts）                                  │
│  URL 解析 · 头合并 · 每次尝试独立超时 signal · 重试循环        │
│  HttpError 快照 · 遥测事件 · 优雅关闭                         │
├─────────────────────────────────────────────────────────────┤
│  dispatcher 拦截链（自外向内）                                 │
│                                                              │
│   rate-limit（可选，最外层）                                  │
│     └─ circuit-breaker（默认开启）                            │
│          └─ cookie（默认开启，最贴近传输）                     │
│               └─ undici Agent（连接池）                       │
├─────────────────────────────────────────────────────────────┤
│  undici fetch（Web 标准 Promise<Response> 语义）              │
└─────────────────────────────────────────────────────────────┘
```

**拦截链顺序的推导**（外 → 内：限流 → 熔断 → cookie → Agent）：

1. **限流最外**：限流拒绝是"我方拥塞"信号，绝不能计入熔断统计（熔断衡量的是**下游健康度**）；熔断打开时也不应白白消耗令牌和并发槽。
2. **熔断居中**：只统计**真正到达网络**的请求。传输错误与 5xx 计失败，4xx 是业务语义不计入。熔断打开时快速失败 `CircuitOpenError`（`retryable: false`），client 层的重试循环看到它立即放弃剩余重试 —— 不会对着打开的熔断器空转。
3. **cookie 最内**：任何上层的失败路径（限流拒绝/熔断打开）都不产生多余的 jar 读写；fetch 的**每次重定向 hop 都会重新走 dispatch**，因此逐跳 Set-Cookie 处理天然正确。

undici `compose` 的语义（`lib/dispatcher/dispatcher.js`）：**先 compose 的在内层**。链式 `agent.compose(cookie).compose(cb).compose(rl)` 中 rl 为最外层。

## 3. 关键设计决策（ADR 摘要）

### 决策 #1：拦截体系完全走 undici 官方契约，不自建抽象

undici v7 的 interceptor 契约为 `(dispatch) => (opts, handler) => boolean`，
`Dispatcher.prototype.compose` 逐层包裹 dispatch 函数并返回原 dispatcher 的 Proxy
（close/destroy 直通）。我们确认并遵循：

- handler 统一走**新接口**（`onRequestStart/onResponseStart/onResponseData/onResponseEnd/onResponseError`），旧接口已 `@deprecated`；新旧接口由 undici 的 `WrapHandler` / `UnwrapHandler` 自动适配。
- 新式 handler **必须实现 `onResponseError`**（`UnwrapHandler` 在错误路径硬性要求）。
- 官方 `DecoratorHandler` 的 .d.ts 尚未声明新接口（类型迁移未完成），因此自实现等价的类型安全基类 `BaseDispatchHandler`。
- **未经真实 dispatch 的失败（熔断打开/排队被拒）必须经微任务延迟递送** `handler.onResponseError(controller, err)`，保证 `dispatch()` 先返回，与 undici 异步错误路径语义一致。

收益：零自研中间件抽象；熔断/限流/cookie 均为可独立测试的 `(状态机, 拦截器)` 二元组；未来 undici 官方新 interceptor（cache/decompress/dns…）可直接 `compose` 进链。

### 决策 #2：重试在 client 层实现，而非 dispatcher interceptor

undici fetch 在 dispatch 层收到的 body 已是**流**（fetch 内部转换），dispatcher 层无法安全重放；undici 官方 retry interceptor 在 fetch 之下对带 body 的请求同样受限。因此重试放在 client 层：

- client 持有**原始 body 值**（string/Buffer/...），每次尝试原样传入 → 重放精确可控；
- `isBodyReplayable()` 判定流式 body → **自动降级为单次发送**（而非重放一个已耗尽的流导致静默失败）；
- 语义在 client 层才完整可见：`Retry-After` 解析（秒/HTTP-date，封顶 `maxDelayMs`）、幂等方法白名单、`canRetry` 业务裁决钩子；
- **每次尝试新建 `AbortSignal.timeout`** 并与用户 signal 经原生 `AbortSignal.any` 合并 → "单次超时 + 总重试预算"语义精确；退避等待期间用户 abort 立即以 `RequestAbortedError` 终止，不再发起剩余重试。

### 决策 #3：自研 cookie 拦截器，不引入 http-cookie-agent

- 消除第三方 peer 依赖随 undici 大版本升级的兼容风险（http-cookie-agent 的导出路径绑定 undici v6）；
- undici fetch 在 dispatch 层的 headers 是小写 key 普通对象（`headersList.entries`）、响应头为 flat Buffer 数组 —— 两条路径均已按源码确认并处理；
- RFC6265 全语义（域/路径/过期/Secure/HttpOnly）委托给 tough-cookie，拦截器只做注入与收集，~140 行可控代码；
- **显式 Cookie 头优先**：调用方设置过 Cookie 则完全不注入 jar cookie（可预期，不隐式合并）；
- 无效 Set-Cookie 单条忽略（一条坏 cookie 不应拖垮整个响应）。

### 决策 #4：熔断器 = 纯状态机 + 拦截器薄壳

`CircuitBreaker` 类不触碰任何 IO（时间由参数注入），可确定性单测；拦截器只做三件事：准入判定 → 包装 handler 观察结果 → 记账。

- 滑动窗口：`windowDurationMs` 按 `buckets` 分桶，O(桶数) 统计，无定时器（无后台任务，进程可干净退出）；
- open → half-open 的转移是**惰性**的（`beforeRequest` / `snapshot` 时按时间推导），无需唤醒定时器；
- 半开探测：并发上限 + 成功阈值；**失败使阈值不可达时立即重新熔断**（不浪费探测名额），成功达阈值**提前恢复**（更快放流量）；
- 恢复（closed）时清空窗口：历史失败不应在刚恢复时立刻再次熔断；
- 每次采样（成功或失败）后都评估失败率（与 resilience4j 一致）—— 3F+2S 的第 5 个成功样本同样可能触发熔断，这是滑动窗口的正确语义。

### 决策 #5：限流器 = 并发槽 + 令牌桶，两个正交维度

- `maxConcurrent`：FIFO 排队，`onResponseEnd/onResponseError/onRequestUpgrade` 三路径归还，`#released` 防重复；
- `requestsPerSecond`：惰性补充令牌（读时按 elapsed 补），队列阻塞于令牌时安排**单个**未来计时器，不轮询；
- 失败模式显式：`queue-full`（队列满，立即拒绝）/ `queue-timeout`（排队超时），均 `RateLimitRejectedError`，`retryable: true`；
- `dispose()` 在 client 优雅关闭时拒绝所有排队者（排队请求尚未开始，快速失败优于悬挂）；
- **默认关闭**：并发/QPS 限制是业务决策，不替使用者做主。

### 决策 #6：遥测在 client 层，事件为纯数据

- client 层同时可见**逻辑结果**（重试后成功/失败、总耗时、attempts）与错误分类 —— interceptor 层只能看到单次 dispatch；
- `TelemetryBus`：监听器异常完全隔离；`StatsCollector`：1024 环形样本精确分位数 + 计数器，内存有界可长期运行；
- 日志桥接按级别过滤（默认 `info`：常规成功 debug 静默、5xx warn、错误 error），桥接任意 pino/winston 风格实现；
- **默认完全静默**：不提供 logger 时零日志输出，不污染宿主日志。

### 决策 #7：错误树 + 归一化（含 fetch 包装解包）

undici fetch 按 spec 把网络错误包装为 `TypeError('fetch failed', { cause })`。`normalizeFetchError` 的判定优先级：

1. 已是 `HttpClientError` → 原样返回；
2. **沿 cause 链解包我们的类型化错误**（熔断/限流错误经 fetch 包装后还原）；
3. 合并 signal 已中止 → 按 reason 区分 `TimeoutError('total')` / `RequestAbortedError`（`AbortSignal.any` 传播首个触发源的 reason）；
4. 沿 cause 链匹配超时标记（headers/body/connect 三阶段）与 errno/undici 码 → 对应类型；
5. 兜底 `NetworkError`（保留完整 cause 链）。

### 决策 #8：FileCookieStore —— 内存语义 + 去抖原子落盘

继承 `MemoryCookieStore`（读写全内存、`synchronous` 语义不变），叠加：

- 启动时 `readFileSync` 一次性加载（过期 cookie 跳过）；
- 变更后去抖写盘，`tmp + rename` 原子替换；写失败保留脏标记下次重试；
- `client.close()` 强制 `flushSync()` —— **优雅关闭不丢数据**；
- 损坏文件重命名 `.corrupt` 隔离后空库启动 —— 持久化故障绝不阻断请求主流程；
- 文件名 `cookies-${sha256(baseURL).slice(0,16)}.json`：多 baseURL 天然分文件隔离。

> 实测注记：tough-cookie 的 `Expires` 只认 RFC1123（`toUTCString()`），ISO 8601 日期会被当作会话 cookie —— 拦截器透传服务器原始 Set-Cookie 故不受影响，但手写测试/构造 cookie 时需注意。

### 决策 #9：Bun 兼容 —— 运行时能力探测 + client 层等价路径（非降级模拟）

**背景**：Bun 将裸说明符 `undici` 无条件解析到内置兼容层（即使 node_modules 里安装了真 undici 也被忽略），其 `Agent`/`Dispatcher` 是没有任何实例方法的空壳（`compose`/`dispatch`/`close` 均缺失）；即使绕过说明符强制加载真 undici 8，也会因 Bun 缺少 Node 22.14+ 的 `util.markAsUncloneable` 在初始化时崩溃。结论：**Bun 下 undici Dispatcher 子系统完全不可用，与依赖版本无关**。

**方案**：构造期做一次能力探测（`supportsUndiciDispatcher()`，检查 `Agent.prototype.compose/dispatch` 是否为函数，结果进程级缓存）：

- **Node（默认路径）**：undici Agent + dispatcher 拦截链（决策 #1~#5 原样）；
- **Bun 等无 Dispatcher 环境**：`fetchViaGlobal()`（`src/bun-compat.ts`）在 client 层等价复现拦截链 —— 限流 acquire/归还在 fetch 调用两侧、熔断准入/记账在响应头到达时、cookie 在每跳前后存取；重定向语义通过 `redirect: 'manual'` + 手动逐跳循环对齐 undici fetch 的「每跳重新走完整 dispatch 链」行为。

**关键等价性设计**：

| 语义                       | dispatcher 路径                              | 全局 fetch 路径                                        |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| 重定向逐跳 cookie          | fetch 层重定向重新 dispatch → 拦截器逐跳生效 | 手动循环显式逐跳 `getCookieStringSync`/`setCookieSync` |
| 重定向逐跳熔断/限流        | 同上                                         | 每跳独立 `beforeRequest`/`acquire` + 归还              |
| 限流槽覆盖 body 传输       | `ReleaseHandler.onResponseEnd` 归还          | 无背压 `TransformStream` 桥，body 完结/出错/取消时归还 |
| 303/301/302 方法转换       | fetch spec 内置                              | `redirectTransform()` 按 spec 实现                     |
| 307/308 + 不可重放流 body  | fetch spec（返回响应）                       | 显式判定 `isBodyReplayable` 后返回 3xx                 |
| 重定向上限 20 跳           | undici 内置                                  | 手动循环常量对齐                                       |
| `response.redirected` 标记 | undici 内置                                  | 实例属性遮蔽补标                                       |

**两路径共享同一套状态机**（`CircuitBreaker`/`RequestLimiter` 本就是纯状态机，拦截器只是薄壳），因此行为一致性由共享实现保证，而非双份代码模拟。查询当前路径：`client.dispatcherMode`（true = dispatcher 链）。

**已知差异**（全局 fetch 路径）：

1. 熔断在「响应头到达」时记账（dispatcher 路径在 `onResponseEnd`，即 body 完结）—— 样本更及时，宏观状态转移等价；
2. `agent` 连接池调优选项不生效（Bun fetch 自管连接池）；
3. 限流槽归还依赖流桥微任务，在响应返回后一拍事件循环内完成；
4. 307/308 携带不可重放流 body 时不跟随重定向，返回 3xx 由调用方决策（与 undici fetch 对流 body 的行为一致）。

## 4. 生命周期

```
运行中 ──close()──► 拒绝排队请求 → agent.close() 等待在途完成 → cookie flushSync
        └─destroy()─► 立即断开在途连接 → cookie flushSync
```

- `close()` 后新请求立即以 `RequestAbortedError('Client is closed')` 失败（早失败，不悬挂）；
- Registry 的 `close()` 并行关闭全部实例（allSettled，单个失败不阻塞其余）。

## 5. 已知边界（显式声明，而非隐式行为）

1. **排队期间的 abort 不会撤销已排队的 dispatch**：undici dispatch 层无 signal。该请求最终仍会发出、响应被丢弃。缓解：`queueTimeoutMs` 兜底。
2. **`CircuitOpenError` 在熔断打开瞬间的竞态**：已通过准入的请求会正常完成；熔断只影响新请求。
3. **重试与熔断的相互作用**：每次重试都是一个熔断样本（它确实占用了下游资源）。持续 5xx + 激进重试会更快触发熔断 —— 这是保护下游的预期行为；熔断打开后剩余重试立即终止（`CircuitOpenError.retryable === false`）。
4. **`throwOnHttpError` 的 body 快照上限 64KB**：更大的 body 被截断（防止日志/内存爆炸）。
5. **HTTP-date 形式的 Retry-After 只有秒级精度**（RFC 1123 限制）。
6. **per-request `retry` 覆盖语义**：显式 `false` 禁用；未设置则**严格继承**构造器配置（含构造器级的禁用）—— 曾经的 bug 已修复并有回归测试（`retry.spec.ts`）。
7. **Bun 限流槽归还的时序**：响应返回后最多一拍事件循环内归还（流桥微任务），高频短请求场景的瞬时 `active` 快照可能略滞后。
8. **tough-cookie 6 的 Cookie 属性名为 `key`**（v5 为 `name`）：`exportCookies()` 序列化产物中 cookie 字段为 `key`；跨大版本导入旧格式需自行转换。

## 6. 扩展指南

**自定义拦截器**（签名：`(dispatch) => (opts, handler) => boolean`）：

```ts
import type { Interceptor } from "./src/index.js";
import { BaseDispatchHandler } from "./src/interceptors/utils.js";

const traceInterceptor: Interceptor = (dispatch) => (opts, handler) =>
    dispatch(
        opts,
        new (class extends BaseDispatchHandler {
            override onRequestStart(controller, context) {
                /* 注入 traceparent 头需改 opts（在 dispatch 前拷贝替换） */
                return super.onRequestStart(controller, context);
            }
        })(handler),
    );
```

由于 client 构造时组装拦截链，深度定制可直接参考 `client.ts` 构造器中
`dispatcher.compose(...)` 的顺序组合自定义拦截器。

**自定义 Cookie 存储**：实现 tough-cookie `Store`（或继承 `MemoryCookieStore`），
经 `cookies: { store }` 注入；`FileCookieStore` 即此模式参考实现。

**代理 / HTTP2**：undici `EnvHttpProxyAgent` / `ProxyAgent` / `Agent({ allowH2: true })`
均实现了 Dispatcher 接口 —— 用它替换 `client.ts` 构造器中的 `new Agent(...)` 即可，
cookie/熔断/限流拦截器对任意 Dispatcher 通用。

## 7. 测试策略

- **单元测试（96 个）**：纯逻辑组件确定性验证 —— 退避数学（jitter 边界）、Retry-After 解析、CB 状态机全转移路径（时间参数注入，无真实计时）、限流器（FIFO/超时/满队/dispose）、URL/头处理矩阵、错误归一化矩阵（构造 fetch 包装/errno/超时标记的假错误链）、FileCookieStore（往返/损坏/过期/去抖）、遥测统计（分位数精确性）。
- **集成测试（68 个）**：真实 `node:http` 本地 server，覆盖重试真实重放、Retry-After 实测延迟、网络层 RST、超时-重试交互（每次尝试独立预算）、abort（含退避期间）、熔断全生命周期（打开→快速失败→半开→恢复）、并发上限实测（服务端计数）、cookie 会话/重定向 hop/持久化跨实例恢复、注册表生命周期。
- **全局 fetch 路径专属（10 个，`global-fetch.spec.ts`）**：直接驱动 `fetchViaGlobal` 验证手动重定向循环（逐跳 cookie、303/307 方法转换、不可重放流 body、20 跳上限）、限流槽 body 完结归还、熔断全链路 —— **同一文件在 Node（vitest）与 Bun（bun test）下都执行**，保证两条运行时行为一致。
- **双运行时验证**：`npx vitest run`（Node，dispatcher 路径）与 `bun test`（Bun，全局 fetch 路径）均 164/164 全绿，连续多轮稳定。
- **稳定性**：连续多轮全量通过（时序断言均预留抖动容差）。

## 8. 与原实现的对照（迁移摘要）

| 原实现                                      | 问题                            | 本方案                                    |
| ------------------------------------------- | ------------------------------- | ----------------------------------------- |
| axios 风格多方法                            | 语义分散                        | 单一 `fetch()`，fetch 标准                |
| `interceptors.redirect` + `maxRedirections` | undici v6 起在 fetch 下不再生效 | fetch 原生 redirect 处理                  |
| 构造器 signal 被丢弃                        | 每次请求 signal 手动合并        | 原生 `AbortSignal.any` + 每次尝试独立超时 |
| `throwErrors` 读 body 后抛错                | 无 body 上限                    | 64KB 截断 + 状态码推导 retryable          |
| http-cookie-agent                           | peer 依赖脆弱                   | 自研拦截器（决策 #3）                     |
| 无重试/熔断/限流/遥测                       | —                               | 四能力全内置且默认值保守                  |
| `combineSignals` 手动 fallback              | 兼容旧运行时代价                | Node 22+ 原生能力直用                     |
