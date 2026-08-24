# P2-38 — 手动 retry 缺少操作幂等性，并发请求会重复创建新 run

- 优先级：P2（操作正确性 / 外部副作用风险）
- 区域：kernel / worker HTTP / dashboard SDK
- 状态：待处理
- 来源：2026-08-24 并发状态转移审查

## 问题摘要

`POST /runs/:id/retry` 的契约是“创建一个新的 run”，因此当前实现刻意不复制源 run 的 `idempotency_key`。但 retry 本身没有请求级幂等 token，也没有记录“某个源 run 的某次 retry 操作已经创建了哪个新 run”。客户端超时、代理重试、用户双击或两个 dashboard 副本并发调用时，每个事务都会读到同一个 terminal 源 run，然后各自插入一个新的 `trigger_type='retry'` run。

这与“不同意图的手动 retry 可以各自创建新 run”并不矛盾：缺少的是区分同一操作重放与新操作的协议字段，而不是简单给 `retryRun` 加一个无条件的全局锁。

## 现状证据

- `packages/kernel/src/runs.ts:1764-1803`：`retryRun` 通过普通 `getRunRow` 读取源 run，没有 `FOR UPDATE` 或 retry-operation 记录；随后调用 `createRunIn`，且没有传 `idempotencyKey`。
- `docs/backend-contract.md:270-274`：明确要求 retry 产生新 run，并说明源 key 不会沿用。这保护了“手动再次尝试”语义，但没有定义网络重试的去重协议。
- `packages/kernel/src/kernel.ts:95-96`、`apps/worker/src/routes/runs.ts:35-37`：kernel 和 HTTP 层均只接收 `runId` 与 namespace，没有 operation key。
- `apps/web/src/features/run/RunView.tsx:37-50` 的按钮禁用只覆盖单个页面的点击状态，不能覆盖请求丢响应后的客户端重试、反向代理重试或多副本调用。

## 真 PG 复现（审查临时库，已清理）

1. 建立一个 `canceled` 源 run。
2. 对同一个 `runId`、同一个 namespace 执行 `Promise.all([retryRun(...), retryRun(...)])`。
3. 两次调用都成功，返回两个不同的 run id；数据库中有两条 `trigger_type='retry'`、状态为 `queued` 的新 run。

源 run 的状态校验没有被绕过，问题在于两个合法事务都被当作不同 retry 操作接受。仅在源行上加锁可以串行化同时到达的调用，却无法识别几秒后携带同一请求意图的再次发送。

## 影响与不变量

- 同一用户操作最多应产生一个 retry child；HTTP 超时后安全重发必须返回第一次创建的 run id。
- 不同的明确操作（不同 operation key）仍可以按现有契约各自产生新 run。
- retry 创建、操作记录和返回 id 必须在同一个事务中提交；不能先返回一个 id 再异步补记关系。
- 源 run 仍只能从 `failed` / `canceled` retry；并发 cancel/retry 或重复 retry 不能把 `completed`/`running` run 变成可重试。

## 推荐实现方案

### 1. 引入请求级 operation key

推荐把 HTTP `Idempotency-Key`（或等价的显式 `retryKey`）贯穿到 worker route、kernel interface、SDK/dashboard client。它的作用域应是 `(project_id, env, source_run_id, operation_key)`，不要复用普通 trigger 的 `(task_id, idempotency_key)` 唯一索引。

可选的数据模型：

- 新增 `run_retry_operations` 表，主键/唯一键为上述四元组，保存 `retry_run_id`、创建时间和请求指纹；或
- 在 `runs` 增加 `retried_from` + `retry_operation_key`，为 `(namespace, retried_from, retry_operation_key)` 建部分唯一索引。

独立关系表更容易保留“同一源 run 可以有多个不同 retry 操作”，也不会让历史 runs 行承载过多协议状态。

### 2. 在一个事务里完成“锁源、判状态、幂等读写、创建”

建议事务顺序：

1. 按现有 canonical order 锁住源 queue 行（通常不存在）再锁源 runs 行；
2. 校验源状态仍是 `failed`/`canceled`；
3. 按 operation key 查已有 retry operation，并锁住它；若已绑定 `retry_run_id`，直接返回该 id；
4. 插入 operation 记录，再创建不继承源 key 的新 run、queue 行和 `notifyWork`；
5. 让唯一约束处理两个并发插入的竞争，冲突方回读已提交的 `retry_run_id`，不能盲目再建 run。

不要把“给源行加 `FOR UPDATE`”当作完整修复：它只能解决同一时刻的竞态，不能解决响应丢失后的重放。

### 3. 明确无 token 的兼容策略

现有无 body 的 retry 路由已经上线，需决定兼容方式：

- 推荐：无 `Idempotency-Key` 仍保留“每次调用都是新 retry”的旧语义；有 key 时提供幂等保证。
- 若产品希望“一个源 run 只能 retry 一次”，可改为 `retried_from` 的单列唯一约束，但这是合约变化，必须同步更新 dashboard、文档和错误码。

## 验收标准

- [ ] 同一 `Idempotency-Key` 的两个并发 retry 请求返回同一个新 run id，数据库只存在一条对应 operation 和一条 retry run。
- [ ] 第一次响应丢失后重发同 key，仍返回原 run id，不重复执行 task。
- [ ] 不同 key 的两次显式 retry 仍各自创建新 run（若选择兼容策略 A）。
- [ ] 无 key 的旧客户端行为和文档保持一致，或有明确版本化迁移说明。
- [ ] retry 与 cancel/terminal 状态转换交错时，只有合法 terminal 源能产生 retry；所有冲突都返回稳定的 `conflict`/`not_found` 错误。
- [ ] 新增真 PG 测试：`Promise.all`、延迟响应重放、不同 key、跨 namespace 隔离、唯一约束冲突回读。
- [ ] 更新 `packages/core` 协议类型、`packages/kernel/src/kernel.ts`、worker route、SDK/dashboard client 和 `docs/backend-contract.md`。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/kernel/src/runs.ts:1764-1803`
- `packages/kernel/src/kernel.ts:95-96,163`
- `apps/worker/src/routes/runs.ts:35-37`
- `apps/worker/src/types.ts`（HTTP 协议）
- `apps/web/src/api/client.ts:232-236`
- `packages/db/src/schema.ts`及新增 migration
- `packages/kernel/test/`
- `docs/backend-contract.md:270-274`
