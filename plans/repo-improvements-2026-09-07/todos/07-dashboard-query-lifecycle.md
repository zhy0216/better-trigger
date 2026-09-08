difficulty: hard
agent: inherit

# Dashboard 查询、分页与凭据生命周期

对应 F13–F15。优先级 P1。前置依赖：无。本任务处理 hooks/API 数据层，不修改 RunView；其控件在 08 中完成。

## T1 · 所有数据请求共享当前查询身份

- 要做什么：把 env/filter/runId/API key version 纳入明确的 generation。切身份立即清空不再属于当前查询的数据、分页游标和错误；loadMore/loadOlderLogs 拥有 controller 并传入已有 API signal 参数，卸载、换 key、换查询时取消；迟到结果无论是否遵守 signal 都不得提交。
- 预计修改：`apps/web/src/api/hooks.ts`，必要的 `apps/web/src/api/client.ts`；`apps/web/test/hooks.test.tsx`、`apiAuth.test.tsx`、`envPropagation.test.tsx`，必要分页测试。
- 验收：key A 的 pending page 在切 key B 时 signal aborted，迟到 page 不进入 B 的 head/tail/logs；prod→staging→prod、run A→B→A 同样安全。凭据撤销/更换后旧数据不以当前身份继续展示；卸载立即释放控制器，旧 finally 不清新 spinner。保留有意暂停时的当前身份画面。
- 前置依赖：无。

## T2 · 终态只来自已接受的当前响应

- 要做什么：移除 fetcher 在 usePoll guard 前更新 terminal 的副作用，终态暂停从当前已接受数据或受 generation 保护的 commit 派生。
- 预计修改：`apps/web/src/api/hooks.ts`、`apps/web/test/hooks.test.tsx`。
- 验收：旧 run 的迟到 completed/failed/canceled 不能 abort 新 run 请求或让新 run 永远 loading；合法终态到达后停止轮询且保持完整详情；run/env/key 变化后重新获取。用受控 deferred promise 复现，不依赖真实时间等待。
- 前置依赖：本文件 T1。

## T3 · 分页使用同步 single-flight 所有权

- 要做什么：为两类分页增加渲染之外可立即生效的请求锁，与 generation/controller 生命周期一起清理；保留独立 tail cursor、去重和错误重试能力。
- 预计修改：上述 hooks 与测试。
- 验收：同一 act/tick 调两次 loader 最多派发一次请求；新 generation 可立即重新加载；旧 promise 完成/失败不会释放新 generation 的锁。已加载数据不重复、顺序不变，合法失败可重试。
- 前置依赖：本文件 T1。

验证：`bun run --cwd apps/web test -- test/hooks.test.tsx test/apiAuth.test.tsx test/envPropagation.test.tsx test/mergeRuns.test.ts test/runView.test.tsx test/logStream.test.tsx`，然后完整仓库 gate。保留 plan 中首次 copy feedback 的失败记录；若 T2 已解释/解决，给 08 明确复现和修复证据。一个最终 commit。
