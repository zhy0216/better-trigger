difficulty: medium
agent: inherit

# Run 详情异步操作与复制反馈

对应 F16–F17。优先级 P1。依赖：07-dashboard-query-lifecycle.md。不改变 retryIntentKey 在请求 settle 后结束意图的现有协议，结果未知时保留 key 的新交互属于 roadmap R2。

## T1 · 防止旧 run 操作影响当前界面

- 要做什么：RunHeader 的 cancel/retry 持有 AbortController 和同步 pending/generation 所有权，把已有 signal 参数传给 API。卸载或 run/env/key 身份改变时退役请求；在 onRetried、recordConnectionError、pending/error 更新前验证身份。
- 预计修改：`apps/web/src/features/run/RunView.tsx`、`apps/web/test/runActions.test.tsx`，必要的 `retryIntentKey.ts` 身份生命周期适配（保留 settle 协议）。API 已支持 cancel/retry signal，优先直接使用，不扩大改动面。
- 验收：发 retry 后离开详情/切 env/key，迟到成功不跳走当前页面，迟到 401 不把新凭据标坏；旧 finally 不清新操作状态。当前界面的合法 retry 仍导航新 run；同 tick 重复入口最多派发一个操作，现有 idempotency header/明确新意图测试通过。取消传输不显示成服务器操作已撤销。
- 前置依赖：07 合入。

## T2 · 查明并稳定复制反馈的时序

- 要做什么：在 07 的当前响应/终态逻辑上复核 plan 记录的 copy test 失败，追踪 CopyButton 的 value effect、request ref、Inspector 重挂载和 clipboard deferred completion。确定性地覆盖发现的时序，再做最小修复；如问题由 07 已修，补充证明并保留原始失败信息。
- 预计修改：`apps/web/src/features/run/RunView.tsx`、`apps/web/test/runView.test.tsx`。
- 验收：完整 hidden payload 被复制并可见 Copied；拒绝访问显示 Copy failed；切 span/run 后旧复制不得更新新目标。新测试能控制导致失败的时序，不能仅增加 waitFor timeout、删断言或靠无解释重复通过。若仍不能复现具体根因，明确报告证据边界，协调器不得伪称已找到根因。
- 前置依赖：07 合入；与 T1 同组件统一验证。

验证：`bun run --cwd apps/web test -- test/runActions.test.tsx test/runView.test.tsx test/logStream.test.tsx test/hooks.test.tsx`；完整仓库 gate；最终含 PG 的根 tests 由协调器执行并记录。无需为复制按钮增加新的产品功能。一个最终 commit，满足全部条目后归档。
