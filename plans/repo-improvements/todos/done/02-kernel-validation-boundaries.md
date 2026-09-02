difficulty: medium

# 02 · kernel 校验边界

本文件覆盖 `packages/kernel` 的输入校验缺口。与 04/05 共享部分内核文件，因此 04/05 显式依赖本文件，串行执行。

## T1 · prune batchSize 下界（P1）

- 做什么：`packages/kernel/src/prune.ts:134` `batchSize` 无校验。`batchSize: 0` → 候选 SELECT `LIMIT 0`、`deleteBatch` 返回 0，终止条件 `:211` `batch.runs < batchSize` = `0 < 0` 恒假 → 死循环、永久占用池连接（GC 循环还会卡住重入标志，retention 从此不再运行）。负值以 `LIMIT -5` 落到 pg 抛裸错。仿 `olderThanMs` 的 `MIN_RETENTION_MS` 下界，校验 `batchSize` 为 ≥1 的安全整数，否则抛 `bad_request`。
- 预计文件：`packages/kernel/src/prune.ts`、`packages/kernel/test/prune*.test.ts`。
- 验收：`batchSize: 0` / `-1` / `1.5` / `NaN` 抛 bad_request；默认值路径不变；新增测试钉住（0/负数/小数）。
- 前置依赖：无。

## T2 · waitForResult 内核侧 pollMs 校验（P2）

- 做什么：`packages/kernel/src/runs-read.ts:281-310` `pollMs: 0`/负数使 `sleep(pollMs)` 变零延时定时器，在整个 timeout 窗口内对 DB 打紧密查询循环。HTTP 路由有 clamp，但内核函数是 embedded-host 路径 + 公开 `Kernel` 方法；同族读接口（`detailLimit`、`logsBefore`）都有校验。对齐：`pollMs < 1` 或非有限值 → `bad_request`（或 clamp 到与路由一致的下界）。
- 预计文件：`packages/kernel/src/runs-read.ts`、内核测试。
- 验收：`pollMs: 0/-1/NaN` 拒绝；正常长轮询行为不变；新增测试。
- 前置依赖：无。

## T3 · claimRuns.limit 上限（P2）

- 做什么：`packages/kernel/src/queue.ts:708-709` 只拒绝 `limit <= 0`；`claimWindow(limit) = max(2*limit, 10)`（`:299-301`），`limit` 取 10⁶ 会在单个事务内 `FOR UPDATE SKIP LOCKED` 锁住至多 2×10⁶ 队列行——正是批上限要防的"长写事务钉死队列行"。在内核边界给 `limit` 设上限（超限 `bad_request`）。
- 预计文件：`packages/kernel/src/queue.ts`、内核测试。
- 验收：超限拒绝并命名该限制；上限内的 claim 行为不变；新增测试。
- 前置依赖：无。

## T4 · registerWorker concurrency 校验（P2）

- 做什么：`packages/kernel/src/workers.ts:90-103` `args.concurrency` 裸绑定，`workers.concurrency` 无 CHECK——垃圾/负值要么入库要么炸出裸 pg 错。校验为正整数，否则 `bad_request`。（workers 行 `project_id`/`env` 列从未写入、恒为默认值且无内核查询读取，属误导数据：本条只在注册时按实际 namespace 上下文处理不改列，列去留见 03 的备注，不在本条范围。）
- 预计文件：`packages/kernel/src/workers.ts`、内核测试。
- 验收：`concurrency: 0/-1/NaN/2.5` 拒绝；合法值不变；新增测试。
- 前置依赖：无。

## T5 · worker 侧输入的枚举/格式校验（P2）

- 做什么：三处内核边界直接吃 worker 消息，非法值以 23514/22007 裸 pg 错（500 级）落地而非 KernelError 族：
  - `packages/kernel/src/runs-steps.ts:240-242` `suspendRun`：`new Date(args.resumeAt)` 非法字符串 → Invalid Date 绑定 → 驱动/pg 错。
  - `:138-152` `upsertStep`：`kind`/`status` 未对 `run_steps_kind_check`/`status_check` 校验。
  - `packages/kernel/src/runs-logs.ts:212-248` `appendLogs`：`level`/`ts` 未校验（对 `logs_level_check` 与 `::timestamptz` cast）；且契约承诺"丢一个 flush 不抛错"，一行坏数据却回滚整块事务——日志行按既有"坏行丢弃 + warn"处理，其余两处抛 `bad_request`。
- 预计文件：`packages/kernel/src/runs-steps.ts`、`packages/kernel/src/runs-logs.ts`、内核测试。
- 验收：非法 `resumeAt`/`kind`/`status` → bad_request；坏日志行丢弃并 warn、同批其余行照常落库；新增测试各覆盖。
- 前置依赖：无。

## T6 · onScanSkipped 移出 claim 事务（P2）

- 做什么：`packages/kernel/src/queue.ts:376-384` `onScanSkipped` 名义是"纯观测"，实际在 claim 事务中途执行：宿主观察者抛错会回滚整个 claim 事务。改为收集被跳过的 namespace、COMMIT 之后再调用回调（或至少 try/catch + warn）。
- 预计文件：`packages/kernel/src/queue.ts`、内核测试。
- 验收：回调抛错时 claim 仍成功；回调仍收到相同内容；新增测试（抛错观察者）。
- 前置依赖：无。

## T7 · 心跳对已删除 worker 行报错（P2）

- 做什么：`packages/kernel/src/queue.ts:903-906` 长分区后 worker 行可能被 prune（离线+超过保留期）而进程仍活着；心跳 `UPDATE ... WHERE id = $1` 命中 0 行却返回成功——worker 继续 claim，但对 `servedTaskIds`/`scanStrandedRuns`/离线标记/dashboard 全部不可见。0 行影响视为错误（返回需重新注册的信号/错误），由调用方重新注册。
- 预计文件：`packages/kernel/src/queue.ts`、`apps/worker/src/runtime.ts`（如需处理新错误码则仅错误处理分支）、内核测试。
- 验收：行不存在时心跳返回明确错误；行存在时行为不变；新增测试。若 runtime 侧改动，仅限把该错误映射为重新注册/告警，不改 claim 逻辑。
- 前置依赖：无。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`；设置 `DATABASE_URL` 时在真 PG 下复跑内核套件（本文件触及队列/心跳路径）。
