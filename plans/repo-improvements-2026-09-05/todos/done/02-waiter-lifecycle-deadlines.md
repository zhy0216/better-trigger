difficulty: hard

# Waiter 关闭竞态与数据库故障下的期限

对应 plan.md：F3、F4。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 关闭期间的注册必须结算

- 做什么：修正 apps/worker/src/waiters.ts 的 register/stop，使首次查询在途时 stop 也能使该调用确定地结束；迟到查询不能插回 pending、不能再返回正常状态掩盖关闭；取消与关闭的先后规则明确，幂等清理。
- 预计修改：apps/worker/src/waiters.ts、apps/worker/test/waiters.test.ts；确有必要时 apps/worker/test/embedded.test.ts。
- 验收：受控序列 register→stop→首读返回 running/terminal/not_found，以及 stop 后迟到 reject，均无孤儿 promise、unhandled rejection 或 pending 项；多次 stop 安全。
- 前置依赖：无。

## T2 · Deadline 不依赖数据库查询成功

- 做什么：注册成功后的等待期限由可清理的机制独立推进；数据库持续报错或 batch read 永不返回也能按最后观测状态 timeout，throwOnTimeout 保留原有错误类型。给在途首次查询的 stop/abort 提供结束路径，不虚构尚未读到的 run 状态。
- 预计修改：同 T1。
- 验收：首读 running 后持续错误/挂起 sweep，短 budget 到期仍结算；终态通知与 deadline/abort/stop 竞态只结算一次，计数不重复；正常 N waiters 仍共享 batch 查询，不退回每个 waiter 一个 DB poll。所有结束路径清 timer/listener。NaN/负 budget 不留下永久等待；保留合法 Infinity/0 语义。
- 前置依赖：本文件 T1。

## T3 · 回归验证

- 做什么：增加受控 deferred promises / fake time 竞态测试。
- 预计修改：上述 tests。
- 验收：bun run --cwd apps/worker test -- test/waiters.test.ts test/embedded.test.ts；deadline、通知、取消和 shutdown 的既有 tests 全通过。
- 前置依赖：本文件 T1、T2。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
