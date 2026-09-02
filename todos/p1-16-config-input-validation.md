# P1-16 — 配置输入校验：RetryPolicy 无范围校验、租约下限、浮点 CLI 值

- 优先级：P1（配置边界硬化）
- 区域：packages/core、apps/worker、packages/sdk
- 状态：待办
- 来源：2026-09-02 全仓库审查（第二轮）

## C1 · `RetryPolicy` 全链路零校验，垃圾策略直落数据库 {#c1}

### 问题摘要

`resolveRetryPolicy` 只补默认值不校验取值。`{ maxAttempts: NaN }` 经 `NaN ?? default`
仍是 NaN，写入后该 task 每次 trigger 都 500；`{ factor: -2 }` / `{ maxMs: -5 }` 产生
负退避，重试零延迟空转烧光 attempts；负 `maxAttempts` 首次失败即终态。注册路径
`JSON.stringify(t.retry)` 直接写 `tasks.retry`；kernel 是唯一边界（子任务不经
HTTP），却没有校验。

### 现状证据

- `packages/core/src/backoff.ts:14-37`：`resolveRetryPolicy` / `computeBackoffMs` 无校验。
- `packages/kernel/src/workers.ts:236`：`JSON.stringify(t.retry)` 直写。
- `packages/sdk/src/task.ts:238-244`：校验了 `schema`/`replay`，独缺 `retry`。

### 推荐实现方案

- 在 core 提供 `RetryPolicy` 范围校验（`maxAttempts` 整数 ≥1；`baseMs`/`maxMs`
  有限且 ≥0；`factor` 有限且 ≥1），`resolveRetryPolicy` 或其入口调用之；
  SDK `normalizeDefinition` 与 kernel 注册路径都走同一校验，错误用既有
  错误族（bad_request/config 语义）而非裸 `Error`。

## C2 · `--lease-ms ≤ 500` 不报错：租约必然先于心跳过期 {#c2}

### 问题摘要

心跳间隔为 `max(500, floor(leaseMs/3))`。`--lease-ms 100` 时心跳 500ms > 租约
100ms，每次认领的租约在首次续约前就过期 → reaper 每轮消耗一次 `recoveries` →
耗尽后 run 以 `WorkerLostError` 终态失败，而 worker 全程活着。

### 现状证据

- `apps/worker/src/cli.ts:413-414`：`--lease-ms` 只经 `requireInt`（>0 即可）。
- `apps/worker/src/runtime.ts:194`：`heartbeatMs = max(500, floor(leaseMs/3))`。
- `apps/worker/src/embedded.ts:103` 附近：embedded `leaseMs` 选项同样无校验。

### 推荐实现方案

- 启动时拒绝 `leaseMs` 低于 `3 × 最小心跳间隔`（或等价下限），一行断言 +
  清晰错误文案；CLI 与 embedded 两个入口都加。

## C3 · `requireInt` 不校验整数，浮点 CLI 值静默生效 {#c3}

### 问题摘要

`requireInt` 只查 `Number.isFinite && > 0`。`--concurrency 2.5` 被
`Array.from({ length })` 静默截成 2（与 `BETTER_TRIGGER_CONCURRENCY` 的严格校验
形成反差）；`--port 4848.5` 到 listen 才失败。

### 现状证据

- `apps/worker/src/cli.ts:220-226`。

### 推荐实现方案

- 改 `Number.isInteger`；`parsePositiveIntEnv` 已是正确写法，可对齐复用。

## 验收标准

- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。
- [ ] 新增单测覆盖：非法 `RetryPolicy`（NaN/负 factor/0 maxAttempts）在注册与
  trigger 路径都被拒绝；`--lease-ms 100` 启动被拒；`--concurrency 2.5` 被拒。

## 涉及文件

- `packages/core/src/backoff.ts`、`packages/sdk/src/task.ts`、
  `packages/kernel/src/workers.ts`、`apps/worker/src/cli.ts`、
  `apps/worker/src/embedded.ts`
