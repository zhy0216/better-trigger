# 简介

better-trigger 是一个 **TypeScript-first、PostgreSQL-backed 的持久化执行（durable execution）runtime**。它让你把耗时长、需要容错的后台工作写成普通的 async 函数——带重试、等待、cron 调度与扇出——并把跨崩溃恢复所需的**一切**存在一个 Postgres 数据库里。**没有 Redis、没有 ClickHouse**——Postgres 是唯一的基础设施。

## 核心思想

一个持久化任务就是普通的 async 函数，只是你用 **step** 把它拆开：

```ts
import { task } from "better-trigger";

export const onboarding = task({
  id: "user-onboarding",
  run: async (payload: { userId: string }, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: user.id });

    await ctx.wait.for("24h");          // 挂起；执行槽被释放
    await ctx.step("send-tips", () => sendTips(user));
  },
});
```

它之所以持久化，靠两条性质：

- **重放而非快照。** 已完成的 step 会被记忆（memoize）在 Postgres 里。崩溃、OOM 或长时间的 `wait` 之后，任务函数从头重跑，已经完成的 step 立即返回缓存结果。你的代码看起来就是一段直线 async 函数，但它可以断点续跑。
- **Postgres 就是引擎。** 队列、编排器循环（定时器、cron、lease reaper）与重放执行器都在 runtime 里，通过 Postgres 行锁（`FOR UPDATE SKIP LOCKED`）协调。任意多个 worker 进程可以共享一个数据库——不需要 leader 选举。

## 怎么跑

有两种部署形态，共享完全相同的 runtime 与语义：

1. **Daemon（默认）。** `better-trigger-worker --tasks ./tasks.ts` 在一个进程里跑执行器、编排器循环与 HTTP API（外加内置 dashboard）。
2. **嵌入式（Embedded）。** 长驻 Node/Bun 应用用 `createEmbeddedRuntime({ tasks })` 在本进程启动同一套 runtime——没有独立进程、不开端口。

负责**触发**任务的 app 安装 SDK——一个**零运行时依赖**、从不打开数据库连接的 HTTP 客户端。

## 内置能力

| 能力 | 说明 |
|---|---|
| 持久化 step | `ctx.step(label, fn)`——记忆化，失败按退避重试 |
| 等待 | `ctx.wait.for("24h")` / `ctx.wait.until(date)`——挂起与恢复 |
| Cron | `task({ cron: "0 9 * * *" })`——基于数据库时钟调度 |
| 父子任务 | `triggerAndWait` / `batchTrigger`——扇出与聚合 |
| 重试 | 带 jitter 的指数退避；`AbortError` 表示不重试 |
| 幂等 | trigger 时传 `idempotencyKey` |
| 并发限制 | 按 payload 键控的每任务上限 |
| 崩溃安全 | 持久租约 + 单调 fencing token → step 历史 exactly-once |
| 可观测 | `/health`、Prometheus `/metrics`、内置 dashboard |

## 下一步

- **[快速开始](./quick-start)**——一条命令跑起来。
- **[编写任务](./writing-tasks)**——`task()` API 与 `ctx` 全貌。
- **[运行 daemon](./running-the-daemon)**——每种部署形态。
- **[嵌入式模式](./embedded-mode)**——单进程宿主。
- **[部署与安全](./deployment)**——鉴权、密钥、限制、TLS。
