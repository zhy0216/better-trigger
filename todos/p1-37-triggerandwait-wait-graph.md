# P1-37 — `triggerAndWait` 幂等复用破坏父子等待图，造成永久 waiting

- 优先级：P1（任务生命周期正确性）
- 区域：kernel / db / sdk contract
- 状态：待处理
- 来源：2026-08-24 并发状态转移审查

## 问题摘要

`triggerAndWait` 复用了普通 `trigger` 的全局幂等语义：同一 namespace 下 `(task_id, idempotency_key)` 只能对应一个 run，但等待关系却是按“父 run 的 step”建立的。父 run 调用 `waitForChildRun` 时，`createRunIn` 只返回已有 run id 和 `idempotent=true`，调用方没有读取已有 child 的状态，也没有验证 child 是否就是自己或已经被别的父等待。

因此同一个 API 可以建立以下非法或不可完成的图：

- 父 run 把自己作为 child 等待；
- 两个父 run 互相等待；
- 父 run 等待一个已经 completed/failed/canceled 的 child；
- 多个父 run 等待同一个 child，但终态路径只处理其中一条 wait；
- child 已经终态提交，而新的 wait 在终态事务的查询之后才提交，永远错过唤醒事件。

这不是 `task_not_found` 问题：当前 `waitForChildRun` 已传 `requireTask: true`（`runs.ts:1308-1319`），本条只处理幂等复用和等待图的一致性。

## 现状证据

1. 普通幂等键的唯一范围是 namespace + task，而不是 parent + step：
   - `packages/db/src/schema.ts:120-126` 的 `runs_task_idempotency_uniq`。
   - `packages/core/src/types.ts:104-109` 仍把 key 描述为“per task”。
2. 冲突读回只取 `id`，不取 `status`、`finished_at`、`parent_run_id` 或当前 waiter 数：
   - `packages/kernel/src/runs.ts:638-649`。
3. `waitForChildRun` 无条件把返回的 id 写进 pending wait，再把父 run 置为 `waiting`：
   - `packages/kernel/src/runs.ts:1297-1344`。
   - `created.idempotent` 没有被检查。
4. 终态唤醒只取 `rows[0]`，没有 `ORDER BY`，所以共享 child 的多个 pending wait 不会全部被处理：
   - `packages/kernel/src/runs.ts:1473-1487`。
5. `completeRun` / `terminalFail` / `cancelRun` 只在 `run.parent_run_id` 非空时调用 `wakeParentIfWaiting`：
   - `packages/kernel/src/runs.ts:1584-1596`、`:1637-1650`、`:1743-1760`。
   - 全局幂等冲突可以让一个 top-level child 被新的 parent 等待，因此“child 自己有没有 parent”不能作为是否存在 waiter 的判据。
6. orphan scanner 只覆盖 `child_run_id IS NULL` 的 wait：
   - `packages/kernel/src/orchestrator.ts:367-377`、`:421-452`。
   - 对“child 已终态但 pending wait 仍带 child id”的情况没有兜底路径。
7. waits 有按 child 的普通索引，但没有 pending waiter 的唯一约束：
   - `packages/db/src/schema.ts:294-305`。

## 真 PG 并发复现（审查临时库，已清理）

以下场景均能在隔离 PostgreSQL 数据库中观察到“父 status=`waiting`、无 queue 行、pending wait 永不完成”的状态：

| 场景 | 操作 | 观察结果 |
|---|---|---|
| 自环 | 已有 parent `(task=t,key=k)` 再在该 parent 内 `triggerAndWait(t, {idempotencyKey:k})` | `child_run_id = parent.id`，pending wait 自指，parent 永久 waiting |
| 已终态复用 | 先完成 `(task=t,key=k)`，再由新 parent 以同 key 等待 | 新 wait 指向 completed child；没有下一次 terminal 事件 |
| 共享 child | 两个 parent 并发以同 key 等待同一个 active child，随后完成 child | `wakeParentIfWaiting` 只完成一个 wait，另一个 parent 留在 waiting |
| 互环 | A→B、B→A 两个 `waitForChildRun` 并发提交 | 两个 run 都 waiting，pending waits 交叉指向，双方都没有终态事件 |
| attach/terminal 窗口 | child 终态事务的 pending-wait 查询与新 parent 的 attach 交错 | terminal 查询看不到尚未提交的 wait；attach 提交后无人再次唤醒 |

## 影响与必须保持的不变量

- `waiting` run 必须存在一个可完成的 pending wait，或者被明确转为 failed/canceled；不能只有 waiting 状态而没有未来事件。
- 一个已终态 child 的结果必须能解析它的所有 pending parent waiters；结果事件不能依赖 `parent_run_id` 是否为空。
- 同一个 parent 的同一个 durable step 只能有一个有效 pending wait，重放不能复制等待关系。
- 父子等待图必须无环；至少要拒绝自环，并对并发形成的环有原子防护。
- 终态提交与 wait attach 必须线性化：attach 看到 terminal child 时应立即完成 step，或 terminal 事务必须看到并处理该 wait，不能出现两者都“成功”但无人唤醒。

## 推荐实现方案

### 1. 先确定幂等语义（推荐默认：durable wait 不接受普通全局 key）

最小且安全的默认方案是：`triggerAndWait` 不允许调用方传普通 `idempotencyKey`，返回明确的 `bad_request`；child 的幂等性由 `(parent_run_id, step_seq)` 这一 durable 操作身份提供。这样每次新的 parent step 都创建新 child，自环和跨 parent 的全局 key 复用不会进入等待图。

如果产品必须支持“多个 parent 共享同一个 child”，不要继续复用 `runs_task_idempotency_uniq` 的隐式语义，而应显式建模：

- 为 child 创建/复用返回 `status`、`finished_at` 和 `id`；
- 用独立的 waiter 关系表示每个 `(parent, step)`，并对 pending `(project_id, env, run_id, step_seq)` 加唯一约束；
- child 终态时按稳定顺序处理**全部** pending waiters。

### 2. 把 attach 与 terminal 结果放到同一条可证明的线性化路径

- 冲突复用时锁住 child 行并检查状态；已终态 child 在同一事务直接写 parent step completed/failed，不再插入 waiting。
- active child 的 attach 必须与 terminal transition 使用一致的锁序或同一个 advisory lock。不能简单地在当前 parent→child 锁序上再让 terminal 路径 child→parent，否则会引入 AB-BA 死锁；可选做法是按 run id 排序加锁、使用专用图锁，或把 terminal result 写入 outbox 后由单一 resolver 消费。
- terminal resolver 按 `id ASC`（或其他稳定顺序）读取并锁定所有匹配 waiters，逐条完成 step、更新 parent、重新入队；处理完后校验没有遗留 pending waiter。
- 所有状态更新都加预期状态谓词并检查 affected rows，避免把已被 cancel/terminal 的 parent 重新置回 queued。

### 3. 加图不变量和观测

- 在 attach 前拒绝 `child_run_id = parent_run_id`。
- 若保留共享 child，使用递归查询/专用图表检测“child 已在 parent 的祖先链上”；并用同一图锁保护检测和插入，避免两个并发事务各自通过检查后组成环。
- 增加 `waiting_without_pending_wait`、`terminal_child_pending_wait`、`wait_graph_cycle_rejected` 指标/结构化日志，方便线上发现遗漏。

## 验收标准

- [ ] `triggerAndWait` 传普通 `idempotencyKey` 时按选定契约稳定返回（推荐为 `bad_request`）；类型、HTTP 文档和 SDK 错误映射一致。
- [ ] 已终态 child 被复用时，parent 不进入 `waiting`；step 在同一事务得到正确的 `{ok, output/error}`。
- [ ] 自环、A↔B 互环和“child 是祖先”的并发用例被拒绝或转为明确失败，数据库中不留下可执行的环。
- [ ] 一个 child 被 N 个 parent 等待时，child 终态后 N 个 wait 都完成、N 个 parent 都重新入队（或按明确的共享语义返回同一结果）。
- [ ] attach 与 complete/fail/cancel 的交错 PG 测试重复运行至少 100 次，不出现 pending wait + terminal child 的组合。
- [ ] 同一 parent/step 的并发重放最多产生一条 pending wait；唯一约束冲突可安全重读已有关系。
- [ ] 更新 `docs/backend-contract.md`、core 类型注释和 kernel API 注释，说明 key 的作用域与环检测语义。
- [ ] `DATABASE_URL=... bun run test`（至少 packages/kernel 真 PG 套件）通过。

## 涉及文件

- `packages/kernel/src/runs.ts:638-649,1272-1344,1461-1596,1608-1651,1721-1761`
- `packages/kernel/src/orchestrator.ts:367-452`
- `packages/db/src/schema.ts:66-135,270-306`及新增 migration
- `packages/core/src/types.ts:104-109`
- `packages/sdk/src/task.ts:102-106`
- `docs/backend-contract.md:194-197`
- `packages/kernel/test/`（真 PG 并发/故障注入回归）
