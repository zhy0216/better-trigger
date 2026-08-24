# better-trigger TODOs — 并发状态转移专项（2026-08-24）

本轮条目来自对 kernel / db 在并发条件下的任务状态转移审查。每个问题一个文件；文件内保留现状证据、影响、不变量、实现方案和验收标准。条目目前都只是待办，不代表修复已经落地。

## 状态：待办

## 优先级与执行顺序

按 `finish-todo` 规则从高到低串行处理；同一文件完成独立实现、对抗式复核和仓库级校验后，才可以归档到 `todos/done/` 并创建该文件对应的 commit。

| # | 文件 | 一句话 | 依赖 |
|---|------|--------|------|
| 1 | [p1-37-triggerandwait-wait-graph.md](./done/p1-37-triggerandwait-wait-graph.md) ✅ | `triggerAndWait` 的全局幂等键可把父 run 接到已终态/自身/环上的 child，造成永久 waiting 或只唤醒一个 waiter | — |
| 2 | [p2-38-retry-idempotency-race.md](./done/p2-38-retry-idempotency-race.md) ✅ | 并发或重放 `/retry` 请求会创建多个语义相同的新 run | — |
| 3 | [p2-39-stale-state-transition-guards.md](./done/p2-39-stale-state-transition-guards.md) ✅ | claim / timer resume 对目标状态缺少防御性谓词，陈旧 queue/wait 行可能复活终态 run | — |
| 4 | [p2-40-log-terminal-boundary.md](./done/p2-40-log-terminal-boundary.md) ✅ | `appendLogs` 的快照检查与终态提交之间存在窗口，日志可在终态提交后才落库 | — |
| 5 | [p2-41-suspend-work-notify.md](./p2-41-suspend-work-notify.md) | suspend 释放并发槽后不发 `work` 通知，其他 run 只能等退避轮询 | — |

## 执行约定

- 一次只推进一个文件；不可把未完成条目移动到 `todos/done/`。
- 每个条目下面的“实现方案”是实现 agent 的边界，不等于本轮已经修改源代码。
- `p2-39` 明确标为防御性 hardening：当前正常锁序下尚未证明会从干净状态稳定复现，必须先用故障注入/陈旧行测试确认边界，再决定是否扩大改动。
- `p2-40` 是“严格日志时间线”与“best effort 低锁开销”之间的产品取舍；实现前需按条目中的推荐默认值做决定。

## 基线校验

本轮审查前使用真 PostgreSQL 运行 kernel 套件：`packages/kernel` 下 37 个 test file、269 个测试通过。新增回归用例应落进同一套测试床，不以临时脚本替代正式验收。
