difficulty: medium

# 消除 worker 构建中重复的 dashboard 编译

对应 plan.md：F16。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 只构建一次、只嵌入新鲜 dashboard

- 做什么：整理 turbo worker/web 依赖与 write-build-info/copy-public 的职责，根构建不再次无条件编译 web。直接在 worker 目录运行 build 仍能从源码得到新鲜 dashboard，可通过经过验证的 orchestration 入口实现；不要仅检测 dist/index.html 存在就复用。
- 预计修改：turbo.json、apps/worker/scripts/write-build-info.mjs、apps/worker/scripts/copy-public.mjs、相关 .d.mts、apps/worker/package.json；必要时新增局部 build helper/tests。Dockerfile 仅在入口确需调整时修改。
- 验收：冷根 build 的 web 实际编译一次；热根 build 能复用 web cache；修改 web 源后 worker/public 更新；直接 worker build、干净 checkout、Docker 调用仍工作。缓存命中不恢复旧 SHA，tracked source 不变。
- 前置依赖：无。

## T2 · 保留交付物边界并验证执行次数

- 做什么：增加 build orchestration 的回归验证，复用 artifact guard 与临时 fixture；验证根与直接调用两条路径，不加入无关构建框架。
- 预计修改：apps/worker/test/artifact-guard.test.ts / build-info.test.ts 或新增目标测试，README 必要的命令说明。
- 验收：bun run build、直接 worker build、bun run check:exports、bun run check:pkg-meta 通过；不同 BT_GIT_SHA 连续构建及 synthetic orphan 检查仍通过；有日志/受控测试证据证明 web 编译次数与新鲜度。
- 前置依赖：本文件 T1。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
