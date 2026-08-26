# SDK API

SDK 是你的应用安装的包：**`better-trigger`**。它定义任务并通过 worker 的 HTTP 面触发它们。零运行时依赖，从不打开数据库连接。

```bash
npm install better-trigger              # 你的应用
npm install -D @better-trigger/worker   # daemon（跑在哪都行）
```

## 导出

```ts
import {
  task,
  betterTrigger,
  unwrapResult,
  AbortError,
  HttpError,
  KernelError,
  SuspendSignal,
  isAbortError,
  isSuspendSignal,
  isControlFlowSignal,
} from "better-trigger";

import type {
  BetterTrigger,
  BetterTriggerOptions,
  RunHandle,
  TaskHandle,
  RunCtx,
  RunRecord,
  RunDetailResult,
  TaskRunResult,
  TriggerOptions,
  RetryPolicy,
  WaitResult,
} from "better-trigger";
```

`better-trigger/internal` 是 daemon 接触执行器存储的接缝——**不是**公开 API，不受 semver 保护。

## `task()`

两种签名：

```ts
export const hello = task("hello", async (payload: { name: string }) => `hi ${payload.name}`);

export const onboarding = task({
  id: "user-onboarding",
  schema: z.object({ userId: z.string() }),   // 可选校验器（Standard Schema / zod 风格）
  retry: { maxAttempts: 5 },
  replay: "lenient" | "strict",               // 默认 'lenient'
  concurrency: { limit: 10, key: (p) => p.userId },
  cron: "0 9 * * *",                          // 或 { pattern, timezone }
  run: async (payload, ctx) => { /* … */ },
});
```

返回 `TaskHandle<TPayload, TOutput>`；payload 与输出类型全程推导。`schema` 鸭子类型化（不强依赖 zod）；校验失败立即失败该 run，不重试。

## `betterTrigger(options)`

```ts
const trigger = betterTrigger({
  url: "http://localhost:4848",   // 默认：BETTER_TRIGGER_URL，然后 localhost:4848
  apiKey: process.env.MY_KEY,     // 默认：BETTER_TRIGGER_API_KEY
  timeoutMs: 30_000,              // 单请求超时
  fetch: myFetch,                 // 可注入 fetch（测试、代理）
});
```

**第一个** `betterTrigger()` 调用会成为模块级默认实例；之后可用 `instance.setDefault()` 接管。可在任何 JS 环境运行——包括 edge 函数与浏览器（`node:async_hooks` 懒加载）。

### 实例 API

| 成员 | 说明 |
|---|---|
| `trigger(taskOrId, payload, opts?)` | 入队一个 run → `RunHandle` |
| `batchTrigger(items, opts?)` | 在单个一次性（all-or-nothing）事务里入队多个 run → `RunHandle[]` |
| `cancelRun(runId)` | 取消非终态 run |
| `retryRun(runId)` | 把 failed/canceled 的 run 作为**新** run 重跑 → `{ runId }` |
| `getRun(runId)` | 完整 run 记录 |
| `getRunDetail(runId, opts?)` | `{ run, steps, waits, logs, … }` 一个快照；默认最新 200 条日志，`opts.logsBefore` 翻更早的页 |
| `waitForResult(runId, namespace?, opts?)` | 等待终态 → `{ status, output?, error? }` |
| `health()` | daemon 存活探针 → `{ ok, version }` |
| `setDefault()` | 把本实例设为模块级默认 |
| `url` | 本实例对话的 base URL |

### RunHandle

```ts
const run = await sendEmail.trigger({ to: "a@b.com" });
//   ^ { id: "run_...", idempotent, result(opts?) }

const settled = await run.result();
//   ^ { status: "completed", output: { delivered: true } }
```

`result()` 等待终态；超时（默认 30s）时返回最新的非终态 status。传 `{ throwOnTimeout: true }` 抛 `ResultTimeoutError`，或传 `signal: AbortSignal` 中断 long-poll。

## 运行上下文（`ctx`）

| 成员 | 说明 |
|---|---|
| `ctx.step(label, fn, opts?)` | 持久化、记忆化 step。返回 `fn` 的结果。抛错触发重试。 |
| `ctx.wait.for(duration)` | 挂起一段时长（`"24h"`、`"10m"` 或毫秒） |
| `ctx.wait.until(date)` | 挂起到某个绝对 `Date` |
| `ctx.logger.{debug,info,warn,error}` | 结构化日志，刷入 Postgres |
| `ctx.now()` | 确定性 `Date`（记忆化） |
| `ctx.random()` | 确定性 `[0,1)` 数字（记忆化） |
| `ctx.uuid()` | 确定性 UUID v4（记忆化） |
| `ctx.run` | `{ id, taskId, attempt, maxAttempts, env }` |
| `ctx.signal` | `AbortSignal`，在取消 / 关停 / 租约丢失时 abort |

## 触发选项

```ts
{
  delay?: string | number;   // "10m" 或毫秒
  idempotencyKey?: string;   // 相同 key → 返回已有 run
  priority?: number;         // 越高越先被 claim
  concurrencyKey?: string;   // 覆盖 concurrency.key()
  env?: string;              // 默认 'prod'
  projectId?: string;        // 默认 'default'
}
```

在运行中的任务内部，`trigger` / `batchTrigger` 会被自动记录为持久化 step；子任务继承父任务的命名空间。

## 错误

| 错误 | 含义 |
|---|---|
| `KernelError` | daemon 以内核 code 应答（`task_not_found`、`run_not_running`、`stale_lease`……）；跨网线携带同一个 `code` |
| `HttpError` | 传输 / 鉴权 / 5xx；有 `status` 与 `code`；生产环境 500 携带 `requestId` |
| `HttpError(0, 'timeout', …)` | 请求撞上自己的单请求超时——与连接失败可区分 |
| `AbortError` | 任务代码主动抛出，让 run 不重试直接失败 |
| `ResultTimeoutError` | `result({ throwOnTimeout: true })` 用完预算；携带最新 status |
| `RunAbortedError` | `ctx.signal.reason`——`'canceled' \| 'shutting_down' \| 'lease_lost'`（`isRunAborted(err)` 可识别） |

`trigger()` 超时后 run **可能已创建、也可能没创建**——安全重试请传 `idempotencyKey`。内核 code 会在客户端还原成 `KernelError`，所以 `err.code` 跨网线读起来一样。

## 重试策略

`step options.retry ?? task retry ?? 默认`。默认是 `{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300000 }`，带 ±20% jitter。`AbortError` 与 schema 校验失败跳过重试。

## Cron

```ts
export const daily = task({
  id: "daily-report",
  cron: "0 9 * * *", // 或 { pattern: "0 9 * * *", timezone: "Asia/Shanghai" }
  run: async () => { /* … */ },
});
```

Cron 触发基于数据库时钟计算；错过的窗口不补跑。
