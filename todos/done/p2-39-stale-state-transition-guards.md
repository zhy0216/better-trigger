# P2-39 — claim / wait resume 缺少预期状态谓词，陈旧行可复活终态 run

- 优先级：P2（状态机防御性 hardening）
- 区域：kernel queue / orchestrator
- 状态：待处理（需先用故障注入确认边界）
- 来源：2026-08-24 并发状态转移审查

## 问题摘要

任务状态转换主要依靠 queue/run/wait 的锁序和调用方不变量，但若陈旧 queue 或 wait 行在异常、历史迁移、手工修复或另一条路径的遗漏中出现，部分 SQL 只按 id 更新，不再验证源状态：

- claim 候选查询按 `queue.locked_by IS NULL` 和 namespace 过滤，但没有把 `runs.status='queued'` 写进候选谓词；后续 `UPDATE runs` 也没有 `status='queued'` 条件。
- timer wait resume 无条件把目标 run 更新为 `queued`，没有 `status='waiting'` 条件。

在理想锁序下这些陈旧行通常不会由正常路径产生，所以本条不是已确认的 P1 主故障；它是状态机的最后一道防线缺失。主 issue P1-37 一旦产生 pending wait/终态 child 异常，正好会放大这类缺口。

## 现状证据

- `packages/kernel/src/queue.ts:407-443`：claim candidate 的 `WHERE` 只有 queue 可用、namespace、task/version 条件，没有 `r.status = 'queued'`。
- `packages/kernel/src/queue.ts:484-503`：claim 更新 `runs.status='running'`，但 `WHERE` 只按 id/project/env；没有检查 `queued`，也没有验证 `RETURNING` 非空后再处理 queue。
- `packages/kernel/src/orchestrator.ts:413-419`：wait 行锁下只确认 `status='pending'`，没有把 run 的 `status='waiting'` 作为 timer resume 的前置条件。
- `packages/kernel/src/orchestrator.ts:485-488`：timer 分支无条件 `UPDATE runs SET status='queued'`。
- `packages/kernel/src/runs.ts:1543-1561` 的 child wake 已经有 `if (parent.status === 'waiting')`，说明不同路径的防护标准并不一致。

## 需要补出的复现/确认

当前审查没有在“只使用公开 API、数据库从干净状态开始”的并发场景稳定触发终态复活；这是本条必须先补的证据。应在真 PG harness 中注入以下陈旧状态，再与并发操作交错：

1. 终态 `runs` + 残留 unlocked `queue` 行 → claim 是否把它重新置为 `running`。
2. `runs.status='completed'` + pending timer wait → orchestrator tick 是否把它置为 `queued` 并重新插队。
3. cancel/complete 与 timer resume 同时提交 → 是否出现终态 run 带 queue 行或 `status='queued'`。
4. queue 行指向已删除/跨 namespace run → claim 是否错误推进 fencing token 或留下锁。

如果这些故障注入只能得到“安全 no-op + 清理陈旧行”，则保留本条作为 hardening；若能从正常 API 产生，应提升为 P1 并在 P1-37/P2-38 之前处理。

## 影响与不变量

- `completed`、`failed`、`canceled` 是单向终态，任何普通恢复/claim 路径不得把它们写回 `queued`/`running`。
- queue 中可 claim 的 run 必须同时满足 `runs.status='queued'`；终态 run 不应有可用 queue 行。
- timer resume 只能把 `waiting` 变成 `queued`；被 cancel/terminal 的 wait 必须成为 no-op 或清理，不得复活 run。
- 任何状态更新影响行数为 0 时，调用方必须停止后续 queue/ledger 写入，并记录可诊断事件。

## 推荐实现方案

### 1. 在 SQL 中表达状态转换

- claim candidate 加 `AND r.status = 'queued'`；claim `UPDATE runs` 加 `AND status = 'queued' RETURNING ...`。
- timer resume 加 `AND status = 'waiting'`，并检查 `rowCount=1` 后才完成 wait step、入队和发送 `notifyWork`。
- reaper、child wake、retry 分支逐一审查同样的“expected old state”谓词；不要只修这两条查询。
- 对 queue 的 `UPDATE/DELETE` 也校验对应 run 状态，避免状态更新失败后仍留下半完成的 queue 变更。

### 2. 处理陈旧行而不是静默覆盖

如果锁下发现 wait/queue 与 run 状态不匹配：

- 不覆盖终态；
- 将陈旧 wait 标记 `canceled` 或写入专门的 orphan/error 状态；
- 删除不再有对应 run 的 queue 行；
- 记录 run id、旧状态、行 id 和来源循环，便于追查产生陈旧行的真正路径。

这些清理动作要沿用 canonical lock order，不能为了清理而反向锁 run/queue。

### 3. 用故障注入和并发回归守住单向性

建立一个可插入旧状态/残留行的 PG helper，反复执行 claim、timer、cancel、complete、reaper 的交错。测试不应只断言最终 status，还要断言 queue、wait、fencing token 和 `finished_at` 的组合一致。

## 验收标准

- [ ] 完成上述四类故障注入，并记录当前实现的实际结果；若证明是正常路径可达，调整优先级并补最小生产复现。
- [ ] claim 不会领取非 `queued` run；状态更新影响行数异常时不会继续写 ledger/queue。
- [ ] timer resume 不会复活 terminal/canceled run；陈旧 wait 被安全关闭并有日志/指标。
- [ ] 并发 cancel/complete/reaper/claim/timer 测试重复运行至少 100 次，无终态回退、queue 残留或 fencing token 非法推进。
- [ ] 保持现有 canonical lock order，不引入新的 queue↔runs 反向锁。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/kernel/src/queue.ts:407-503`
- `packages/kernel/src/orchestrator.ts:383-511,674-714`
- `packages/kernel/src/runs.ts:1461-1761`
- `packages/kernel/test/`（新增故障注入/状态机不变量测试）
- `packages/db/src/schema.ts`（如需陈旧行状态或约束）
