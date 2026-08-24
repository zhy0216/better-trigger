# P2-41 — suspend 释放并发槽后没有 `work` 通知，后继 run 只能等退避

- 优先级：P2（并发调度延迟）
- 区域：kernel / worker runtime
- 状态：待处理
- 来源：2026-08-24 并发状态转移审查

## 问题摘要

`suspendRun` 把当前 run 置为 `waiting` 并删除 queue 行，从而释放它占用的 task/concurrency slot，但成功事务没有调用 `notifyWork`。如果同一 `concurrency_key` 下已有 queued run，其他 worker 的 claim loop 可能正处于 300ms→2s 的 idle backoff；它不会被这次 slot 释放立即唤醒，只能等下一次轮询。

这不是数据正确性故障：polling fallback 最终会领到后继 run。但它让 `wait.for`/`wait.until` 这种常见的“主动释放槽位”路径产生不必要的尾延迟，并与 terminal/reaper/resume 路径已经发送 `work` 通知的语义不一致。

## 现状证据

- `packages/kernel/src/runs.ts:1189-1247`：非立即到期的 suspend 插入 wait、更新 run 为 waiting、删除 queue，函数随后直接返回，没有 `notifyWork`。
- `packages/kernel/src/notify.ts:4-25,40-46`：`work` 通知就是让 idle claim loop 立即醒来；polling 只是 fallback。
- `apps/worker/src/runtime.ts:240-292`：claim loop 无活时采用 300ms 起步、最大约 2s 的退避；收到 `work` 才能提前结束 sleep。
- `packages/kernel/src/orchestrator.ts:508-511`、`packages/kernel/src/runs.ts:1644-1651,1754-1761`：timer resume、complete/fail/cancel 已在释放/产生可领工作时通知，suspend 是漏掉的状态转换。

## 并发复现/测量

建议在真 PG + 两个 worker harness 中测量：

1. 任务 concurrency limit=1，worker A 正在运行 run A；队列中已有 run B。
2. A 调用 `suspendRun`，确认 A 进入 waiting、queue 行被删除。
3. 让 worker B 的 claim loop 在通知前进入 idle backoff，记录 B 开始执行的时间。
4. 对比补发 `notifyWork` 后的时间；当前实现的上界接近下一次退避（最高约 2s，叠加 jitter）。

## 影响与不变量

- suspend 成功提交后，已释放的并发槽应尽快对其他 claim loop 可见。
- `notifyWork` 必须是事务最后一条语句，只有 commit 后才唤醒；回滚不能产生假唤醒依赖。
- 通知是优化而不是唯一正确性机制，不能删除现有 polling fallback。
- 不应为每个无并发限制的 suspend 产生无意义的高频通知，或至少要证明该成本可接受。

## 推荐实现方案

### 1. 在 suspend 事务内按需通知

`assertOwnedRunning` 已返回 run 行。可在成功删除 queue 后检查 `run.concurrency_key`（或 task 的实际 limit）并调用 `notifyWork(client)`；若选择简单一致性，也可以所有成功 suspend 都发一个聚合的 bare `work` 通知，因为通知 payload 不带 run id 且 PostgreSQL 会合并同事务内重复通知。

推荐先按 `concurrency_key != null` 发，减少无并发任务的噪声；同时确认“任务 limit 由 tasks 表更新/注销”时不会漏掉需要唤醒的等待者。

### 2. 保持事务和 fallback 语义

- `notifyWork` 必须作为事务最后一条 SQL，不能在 `COMMIT` 后用另一个连接发送。
- `resumed: true` 的立即完成路径没有释放 queue/slot，不应发送该通知。
- 为通知失败保留现有错误处理/轮询兜底；不要让一个 NOTIFY 失败把已成功提交的 suspend 回滚成执行失败，除非当前 `withTx` 约定明确要求如此。

### 3. 增加延迟指标和测试

记录 suspend→后继 claim 的 p50/p95，或至少增加一个 kernel test 验证成功 suspend 触发一次 `work`。测试还要覆盖事务回滚、无 concurrency key 和多个并发 suspend 的通知聚合。

## 验收标准

- [ ] 非立即到期的 suspend 成功提交后，符合条件的 worker 能被 `work` 通知唤醒；后继 run 不再被迫等待完整 idle backoff。
- [ ] `resumeAt` 已到期的同步路径不产生多余通知。
- [ ] suspend 事务回滚时监听器看不到依赖该事务的 `work` 通知，现有 polling fallback 仍工作。
- [ ] 并发 limit=1 的 PG/worker harness 测试给出通知前后延迟证据，并确认不改变状态机结果。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/kernel/src/runs.ts:1189-1247`
- `packages/kernel/src/notify.ts:4-67`
- `apps/worker/src/runtime.ts:240-292`
- `packages/kernel/test/`、`packages/testing/`（并发槽位/通知延迟测试）
- `docs/backend-contract.md:187-192`（如需公开延迟语义）
