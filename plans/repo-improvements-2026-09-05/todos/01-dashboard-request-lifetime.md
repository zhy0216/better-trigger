difficulty: medium

# Dashboard 完整请求生命周期

对应 plan.md：F1、F2。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 超时覆盖响应正文并清理取消监听器

- 做什么：修正 apps/web/src/api/client.ts 的 request，使同一个 10s deadline 覆盖 fetch 和成功/错误正文读取；finally 统一清 timer 与具名 abort listener；预取消不调用 fetch。用户取消保留取消语义，超时作为可见失败，不被 usePoll 当成普通 AbortError 吞掉。
- 预计修改：apps/web/src/api/client.ts、apps/web/test/client.test.ts；需要验证轮询恢复时扩展 apps/web/test/hooks.test.ts。只在有必要时调整 api/hooks.ts。
- 验收：立即返回 headers、正文永不结束的 200 与 5xx 均在期限内拒绝；正文中途取消正确传播；成功/非 JSON 错误/超时/取消后 listener 和 timer 全清理；401 code/requestId 解析不变。下一轮正常响应后 UI 轮询恢复。
- 前置依赖：无。

## T2 · 用可取消流验证真实行为

- 做什么：用受 AbortSignal 驱动的 ReadableStream 或等价受控 fixture 模拟 header/body 分离，不只 mock setTimeout 调用次数。
- 预计修改：上述 tests。
- 验收：本任务测试在旧实现上能复现挂住/监听器残留，在新实现上通过；bun run --cwd apps/web test。
- 前置依赖：本文件 T1。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。
