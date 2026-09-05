difficulty: medium

# Duration 与 retry 的有限值和存储边界

对应 plan.md：F11。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · Duration 永远不产出非有限毫秒或 Invalid Date

- 做什么：parseDuration 的字符串总和/乘法溢出应像数字非有限输入一样拒绝；durationToDate 检查无效 from 与最终时间。保留正常小数向下取整、compound、重复单位拒绝和可表示的大日期行为。
- 预计修改：packages/core/src/duration.ts、packages/core/test/duration.test.ts。
- 验收：310 位数字+w、单位乘法溢出、Invalid Date from 都清晰失败；有效 Date 边界通过；源 Date 不变。
- 前置依赖：无。

## T2 · Retry 不把已接受配置变成 NaN 或数据库 int 溢出

- 做什么：validateRetryPolicy 的 maxAttempts 限制到目标 PostgreSQL integer 可表示的正整数；computeBackoffMs 对 zero base / exponent 溢出安全，保留当前“先 cap 再 jitter”定义。检查合法但极大 policy 值是否仍能产生不合法时间，并在该边界明确拒绝或安全饱和。
- 预计修改：packages/core/src/backoff.ts、packages/core/test/backoff.test.ts；packages/kernel/test/retry-policy-validation.test.ts 可补直接调用验证。
- 验收：maxAttempts=2147483648 在数据库查询前被拒；边界值可用；attempt=1025/baseMs=0/factor=2 返回 0，不是 NaN；正常 jitter/backoff tests 不变，生产路径不会向数据库写非有限重试时间。
- 前置依赖：无。

## T3 · 跨模块验证

- 做什么：运行 core/kernel retry tests 与仓库 gate。
- 预计修改：上述范围。
- 验收：bun run --cwd packages/core test；kernel retry-policy tests；独占 PG 上 kernel 全套通过。core 保持零运行时依赖，无泛化大重构。
- 前置依赖：本文件 T1、T2。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
