# 编写任务

任务是用 SDK 的 `task()` 创建的对象，有两种签名：

```ts
import { task } from "better-trigger";

// 简写形式——id + run 函数
export const hello = task("hello", async (payload: { name: string }) =>
  `hi ${payload.name}`
);

// 配置形式——完整选项
export const onboarding = task({
  id: "user-onboarding",
  schema: z.object({ userId: z.string() }), // 可选；校验并推导 payload 类型
  retry: { maxAttempts: 5 },
  replay: "strict",                        // 可选；默认 'lenient'
  concurrency: { limit: 10, key: (p) => p.userId },
  cron: "0 9 * * *",                       // 或 { pattern, timezone }
  run: async (payload, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: user.id });
    await ctx.wait.for("24h");
    await ctx.step("send-tips", () => sendTips(user), { retry: { maxAttempts: 2 } });
    return user.id;
  },
});
```

payload 与返回类型全程自动推导：payload 类型来自 `run` 的参数（或 `schema`），返回类型一路传递到 `triggerAndWait`。

`schema` 接受任何实现 [Standard Schema](https://standardschema.dev) `~standard` 接口的对象，或暴露 `parse` / `safeParse` 的 zod 风格对象——校验完全鸭子类型化，**不强依赖 zod**。校验失败会立即失败该 run，不重试。

::: warning 必须可独立 import
任务模块会被 daemon 在自己的进程里 import，所以必须能独立加载——`run` 函数**不能**闭包你 app 的请求上下文或内存单例。嵌入式任务以 handle 形式传入，可以使用应用级依赖，但持久化 run 仍不能捕获重启后无法重建的 request-scoped / 临时状态。
:::

## 运行上下文（`ctx`）

| 成员 | 说明 |
|---|---|
| `ctx.step(label, fn, opts?)` | 跑一个持久化、记忆化的 step。返回 `fn` 的结果。抛错触发重试。 |
| `ctx.wait.for(duration)` | 挂起一段时长（`"24h"`、`"10m"` 或毫秒）。执行槽被释放。 |
| `ctx.wait.until(date)` | 挂起到某个绝对 `Date`。 |
| `ctx.logger.{debug,info,warn,error}` | 结构化日志，缓冲后刷入 Postgres。 |
| `ctx.now()` | 确定性 `Date`——重放时记忆化。 |
| `ctx.random()` | 确定性 `[0, 1)` 数字——记忆化。 |
| `ctx.uuid()` | 确定性 UUID v4 字符串——记忆化。 |
| `ctx.run` | `{ id, taskId, attempt, maxAttempts, env }` 运行元数据。 |
| `ctx.signal` | `AbortSignal`，在 run 被取消、worker 关停或租约丢失时 abort。 |

### step 之间的确定性

step *之间*的代码每次重放都会重跑，所以它必须是确定性的。把副作用、时间与随机放进 `ctx.step` 里，或使用 `ctx.now()` / `ctx.random()` / `ctx.uuid()`——三者都是记忆化的迷你 step，重放时返回与首跑相同的值。

### “禁止 catch-all” 规则

挂起与结束一次执行是通过**抛内部信号**来传递的。用 catch-all 包住持久化原语会破坏 run：run 明明已经 `waiting` 或终态，你的代码却还在跑，副作用重放时还会再发生一次，且从未被记录。

```ts
try {
  await ctx.wait.for("1h");
} catch (err) {
  if (isControlFlowSignal(err)) throw err; // 挂起信号 AND 结束信号
  // ……你自己的处理
}
```

使用 SDK 导出的 `isControlFlowSignal`——它同时识别挂起信号与结束信号。若漏掉了信号，runtime 会在下一个持久化原语处以 `AbortError` 加一条 `warn` 日志把它抓住。

## 失败与重试

```ts
task({
  id: "charge",
  retry: { maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300_000 },
  run: async (payload, ctx) => {
    await ctx.step("charge", () => charge(payload)); // 抛错 → 按退避重试

    if (payload.amount <= 0) {
      throw new AbortError("invalid amount"); // 立即失败，不重试
    }

    await ctx.step("notify", () => notify(payload), { retry: { maxAttempts: 2 } });
  },
});
```

step 生效的重试策略是 `step options.retry ?? task retry ?? 默认`。默认是 `{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300000 }`，带 ±20% jitter。`AbortError`（以及 schema 校验失败）跳过重试。

## 触发

```ts
// 单个 run
const run = await sendEmail.trigger({ to: "a@b.com" });
await sendEmail.trigger({ to: "a@b.com" }, { delay: "10m", idempotencyKey: user.id });

// 多个 run——单个命名空间里的一次性（all-or-nothing）批量
const handles = await sendEmail.batchTrigger(
  [{ payload: { to: "a@b.com" } }, { payload: { to: "b@b.com" } }],
  { env: "staging" }
);

// 持久化父子任务（只能在任务内）
const result = await processVideo.triggerAndWait({ url });
if (result.ok) console.log(result.output);
```

### 触发选项

```ts
{
  delay?: string | number;   // "10m" 或毫秒
  idempotencyKey?: string;   // 相同 key 再次触发会返回已有 run
  priority?: number;         // 高优先级 run 优先被 claim
  concurrencyKey?: string;   // 覆盖 concurrency.key() 的结果
  env?: string;              // 环境范围（默认 'prod'）
  projectId?: string;        // 项目范围（默认 'default'）；与 env 成对
}
```

`env`/`projectId` 决定 run 的命名空间。`batchTrigger` 在**批量**调用上接收它们；单条 item 的选项被收窄、排除这两项。在运行中的任务内部，子任务总是继承父任务的命名空间。当 `trigger` / `batchTrigger` 在**运行中的任务内部**调用时，它们会被自动记录为持久化 step——重放时再次触发是幂等的。

### `triggerAndWait` 永不因子任务失败而抛错

`triggerAndWait` 挂起父任务直到子任务结束。它返回 `TaskRunResult = { id, ok, output?, error? }`，子任务失败时**不抛错**——检查结果，或用 unwrap：

```ts
import { unwrapResult } from "better-trigger";

const result = await child.triggerAndWait(payload);
const output = unwrapResult(result); // 子任务失败则抛错
```

## Cron 任务

```ts
export const dailyReport = task({
  id: "daily-report",
  cron: "0 9 * * *", // 或 { pattern: "0 9 * * *", timezone: "Asia/Shanghai" }
  run: async () => { /* … */ },
});
```

Cron 触发基于**数据库时钟**（`now()`）计算，所以时钟偏斜的 daemon 不可能让同一调度连续触发两次。错过的窗口（比如所有 daemon 都停机）不会补跑——下一次从当前时间计算。注册时会 upsert 一条 `schedules` 记录，dashboard 会展示它，你也可以启用/停用。
