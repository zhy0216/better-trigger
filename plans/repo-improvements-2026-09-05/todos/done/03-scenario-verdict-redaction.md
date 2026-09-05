difficulty: medium

# 验收结果可信度与日志脱敏

对应 plan.md：F5、F6、F7。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 所有异常和清理失败进入最终退出码

- 做什么：runScenario 用独立标志记录捕获异常，支持任意 JS 抛值；runTeardown 保持 LIFO、全部尝试，收集失败并合入 verdict，不能把原始 body failure 覆盖成 cleanup error。
- 预计修改：packages/testing/src/scenario.ts；packages/testing/test/scenario.test.ts（新增）；需要时新增 test/fixtures/scenario-probe.ts。
- 验收：throw null/undefined/false/0/空串/Error 都非零；仅 cleanup 失败也非零；多个 cleanup 仍按 LIFO 全执行；body 与 cleanup 同时失败时均可诊断；真正成功 exit 0。测试验证 runScenario 最终 verdict/退出行为，不只检查私有计数。
- 前置依赖：无。

## T2 · 数据库身份日志不包含凭据

- 做什么：替换直接输出 db.url 的行为，只显示可用来定位测试实例的脱敏 host/port/database；可采用局部纯函数，不修改数据库配置本身。
- 预计修改：packages/testing/src/scenario.ts、上述 tests。
- 验收：使用合成 user/password、百分号编码密码与 query 密码参数检查 stdout/stderr，不能出现原文或解码密码；仍能找到实际测试库名。所有 fixtures 使用假凭据。
- 前置依赖：无。

## T3 · 运行测试工具回归

- 做什么：运行 packages/testing 现有测试与新 scenario tests。
- 预计修改：上述范围。
- 验收：bun run --cwd packages/testing test；原有 poll/database/daemon/invariants tests 不退化；执行约束中的全仓库 checks 通过。
- 前置依赖：本文件 T1、T2。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
