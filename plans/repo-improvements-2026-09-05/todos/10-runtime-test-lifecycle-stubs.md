difficulty: medium

# 让运行时测试真正覆盖成功关闭

对应 plan.md：F17。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 补齐 fake kernel 生命周期行为

- 做什么：修正 runtime-outcomes、runtime-cancel、crash-context 中不完整的 fake kernel，补 releaseClaims 和 deregisterWorker 及合理返回值；收窄无约束 as unknown as Kernel 的用法，必要时建立只覆盖这些测试的 typed helper。
- 预计修改：apps/worker/test/runtime-outcomes.test.ts、apps/worker/test/runtime-cancel.test.ts、apps/worker/test/crash-context.test.ts；必要时新增 test/helpers/kernel.ts。
- 验收：正常 handle.stop 不再输出 'kernel.releaseClaims is not a function' / 'kernel.deregisterWorker is not a function'；断言各方法实际被调用，错误对象模拟仍符合 Kernel 契约；原有 run outcome/cancel/crash context 断言保留。
- 前置依赖：无。

## T2 · 验证正常和故障两类 shutdown

- 做什么：为上述 fixtures 增加最小但有意义的成功关闭断言；保留 runtime-shutdown.test.ts 对真实 release/deregister 失败的观测检查，不把所有 console.error 全局静音。
- 预计修改：上述 tests；runtime-shutdown.test.ts 仅必要适配。
- 验收：bun run --cwd apps/worker test -- test/runtime-outcomes.test.ts test/runtime-cancel.test.ts test/crash-context.test.ts test/runtime-shutdown.test.ts；全仓库 test 日志不再含这两个非预期 TypeError，预期错误路径仍得到断言。
- 前置依赖：本文件 T1。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
