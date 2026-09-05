difficulty: medium

# SDK 单次请求 timer 范围

对应 plan.md：F12。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 在派发前拒绝 timer 溢出的 timeout

- 做什么：HttpClient 构造及每次 request override 共用 timeout 校验，定义大于 0 且不超过 2147483647ms 的有限值范围。保留已有合法小数处理约定，不能让运行时把超大值降为 1ms。
- 预计修改：packages/sdk/src/client.ts、packages/sdk/test/client.test.ts、packages/sdk/README.md、apps/docs/reference/sdk-api.md、apps/docs/zh/reference/sdk-api.md。
- 验收：2147483648、Number.MAX_VALUE、Infinity、NaN、0/负数均在 fetch/timer/listener 建立前失败；最大合法值通过；构造与 override 一致，错误指出 timeoutMs 与范围。
- 前置依赖：无。

## T2 · 区分请求 timeout 与 durable wait budget

- 做什么：文档明确限制只作用于单次 HTTP 请求；SDK waitForResult 的 Infinity 通过多段 long-poll 仍有效，durable ctx.wait.for 的长时间日期也不受此限制。
- 预计修改：上述 README/文档/tests；原则上不修改 instance.ts，本任务与后续 07 留出顺序。
- 验收：bun run --cwd packages/sdk test；Infinity waitForResult 的已有测试继续通过；不新增 SDK 运行时依赖。
- 前置依赖：本文件 T1。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
