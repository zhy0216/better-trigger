# P2-33 — Runs 列表:搜索只过滤已加载页造成假空态;`cancelRun`/`retryRun` 已实现却无 UI 调用点

- 优先级:P2(dashboard 功能完整性)
- 区域:web
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」web #7/#8)

## 现状

- `apps/web/src/screens/RunsList.tsx:31-35`:搜索是 `(source ?? []).filter(r => r.task.includes(q) || r.id.includes(q))`——只筛**已加载**的 50 条;`useRuns` 与 `RunFilters.taskId` 明明支持服务端过滤却从不传。task 名不在最新 50 条里 → "No runs match these filters." 的假空态。
- 状态 chips 漏掉 `waiting` 与 `canceled`(服务端接受、`adapter.ts:31-38` 有映射)。
- `apps/web/src/api/client.ts:229-240` 的 `cancelRun` / `retryRun` 全仓零调用——run detail(自称 "the hero")能看失败堆栈却不能 retry/cancel。architecture.md P4 说 "手动触发/重试/取消已在 REST 上",UI 侧没接。
- `RunFilters.projectId` 声明了从没人读(`nsQuery` 写死 `PROJECT_ID`)。

## 实现方案

1. 搜索:输入按 taskId 语义传给服务端(`useRuns(env, { status, taskId })`);保留客户端 `q` 作为标注清楚的"页内细筛"(placeholder 写 "filter loaded page… "),或干脆全走服务端——以服务端为准。
2. 补 `waiting`、`canceled` 两个 chips(映射已就绪)。
3. `RunView` 的 `RunHeader` 接上动作:terminal-failed → Retry;queued/running/waiting → Cancel;复用 `Schedules.tsx` 的乐观覆盖模式,失败回滚 + toast。
4. 删掉或接上 `RunFilters.projectId`(现阶段单 project 写死,删声明更诚实)。
5. 测试:假空态用例(mock 服务端过滤返回命中)、retry/cancel 的乐观流与回滚。

## 验收标准

- 搜索能命中不在当前页的 task;chips 全集可用。
- run detail 可 retry 失败 run、cancel 运行中 run,乐观状态与服务端最终一致。
- `client.ts` 无零调用的导出(要么接上要么删)。

## 涉及文件

- `apps/web/src/screens/RunsList.tsx:10-35`
- `apps/web/src/api/client.ts:168-175,229-240`、`apps/web/src/api/adapter.ts:31-38`
- `apps/web/src/screens/RunView.tsx`(RunHeader)、`apps/web/src/screens/Schedules.tsx:21`(模式参照)
- `apps/web/test/`
