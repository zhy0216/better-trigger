difficulty: hard

# Kernel 等待选项与取消/超时语义

对应 plan.md：F13。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 建立共享、兼容的 ResultTimeoutError

- 做什么：将 transport-neutral 的 ResultTimeoutError 放到 core（可新增独立文件），SDK instance/index 保持原导出，worker 使用同一类；kernel 不导入 SDK。保留构造参数、name、status、message 和 instanceof 身份。
- 预计修改：packages/core/src/index.ts、packages/core/src/types.ts 与新增错误文件/测试；packages/sdk/src/instance.ts、packages/sdk/src/index.ts、apps/worker/src/waiters.ts；相关 SDK/worker tests。
- 验收：SDK 原入口 import 不变；SDK、worker registry、kernel 超时错误 instanceof 同一构造器；check:deps、check:exports 通过。
- 前置依赖：02-waiter-lifecycle-deadlines、05-core-numeric-boundaries、06-sdk-request-timeout-range。

## T2 · Kernel waitForResult 履行 options 契约

- 做什么：在 packages/kernel/src/runs-read.ts 实现预取消、等待中取消、throwOnTimeout 与 timeout 类型/范围验证；NaN 不可变成永久循环。用剩余 budget 调整最后一段 sleep，不再提前一个 poll 返回。保留 timeout=0 的即时读与合法 Infinity 等待；pollMs 必须能安全调度（拒绝超过 timer 范围或分段等待）。
- 预计修改：packages/kernel/src/runs-read.ts、packages/kernel/test/wait-for-result.test.ts；必要的新 PG regression。
- 验收：预取消零查询；sleep/query 在途期间取消及时拒绝且无后续轮询/未处理拒绝；throwOnTimeout 带最后状态；0、NaN、负值、Infinity、pollMs > budget 各有明确测试；终态结果不变。不要声称 Promise.race 本身会取消 PostgreSQL SQL。
- 前置依赖：本文件 T1。

## T3 · HTTP 无 registry fallback 传递客户端取消

- 做什么：apps/worker/src/routes/runs.ts 给 kernel fallback 传 request signal，正确映射客户取消，与 registry 路径保持 499 约定；不要把无关数据库错误吞成取消。
- 预计修改：apps/worker/src/routes/runs.ts、apps/worker/test/http.test.ts / waiters.test.ts（按现有覆盖定位）、apps/docs/reference/sdk-api.md 与中文对应文档、packages/sdk/README.md。
- 验收：无 registry 的路由中断能结束 kernel 等待；正常 terminal/timeout 响应形状不变；错误身份一致。
- 前置依赖：本文件 T1、T2。

## T4 · 跨层验证

- 做什么：运行 kernel wait、SDK wait、worker waiters/HTTP 测试，独占 PG 上跑 kernel 全套和 embedded/notify acceptance。
- 预计修改：上述范围。
- 验收：各层共享错误身份与行为测试通过，全仓库校验、check:deps、重建后 check:exports 通过。
- 前置依赖：本文件 T1～T3。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
