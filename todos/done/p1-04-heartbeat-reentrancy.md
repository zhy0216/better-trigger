# P1-04 — heartbeat 的 `setInterval` 无重入保护，慢 tick 会并发；stop 后仍可能点亮 workers 行

- 优先级：P1（并发正确性）
- 区域：apps/worker（runtime）
- 状态：待办
- 来源：2026-08-26 全仓库审查

## 问题摘要

heartbeat 用 `setInterval` 无重入保护：一次 tick 超过 `heartbeatMs` 时与下一 tick 并发。kernel orchestrator 的六个循环都有 re-entrancy guard（orchestrator.ts:313-332），heartbeat 没有。`stop()` 只 await 最后一次 `heartbeatTick`，并发 tick 可能在 `deregisterWorker` 之后落库、把 workers 行重新点亮——正是其注释要防的离线回收症状。

## 现状证据

- `apps/worker/src/runtime.ts:198-237` — heartbeat setInterval + heartbeatTick。
- `packages/kernel/src/orchestrator.ts:313-332` — 既有 loop() re-entrancy guard 范式。
- `apps/worker/src/runtime.ts:300-305` — stopping 分支已有 releaseClaims 正确示范。

## 影响与不变量

- 任意时刻至多一个 heartbeatTick 在跑。
- `stop()` 返回后，不得再有 tick 写 workers 表；deregister 之后不得把行重新点亮。
- 心跳周期内发生瞬时慢 tick 不得引发错乱计数或重复写。

## 推荐实现方案

- 给 heartbeat 加同款 running 标志（或改用 setTimeout 链 / 复用 kernel 的 loop 抽象），tick 结束才排下一个。
- `stop()` 等待当前 tick 真正结束并置停止标志，确保无后续写。
- 补测试：模拟慢 tick 下不并发；stop 后无新写。

## 验收标准

- [ ] 慢 tick 不会与下一 tick 并发。
- [ ] stop() 后 workers 行不被重新点亮。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `apps/worker/src/runtime.ts:198-237`
- `packages/kernel/src/orchestrator.ts`（参考 loop 抽象）
- `apps/worker/test/`
