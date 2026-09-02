# P1-17 — dashboard 过期响应竞态 + 静默错误 + 可读性打磨

- 优先级：P1（数据正确性 / 可用性）
- 区域：apps/web
- 状态：待办
- 来源：2026-09-02 全仓库审查（第二轮）

## C1 · 分页/日志的过期响应把旧数据写进新列表 {#c1}

### 问题摘要

`loadMore` 与 `loadOlderLogs` 的分页请求在途时，若用户切换 env/筛选（或切换
run），重置 effect 会先清空 `tail`/`olderLogs`，但在途响应随后仍 `setTail`/
`setOlderLogs`，把**旧 env/旧 run 的数据**追加进新列表，且一直停留到下次身份
变更。无 queryKey 陈旧守卫、无 AbortController。

### 现状证据

- `apps/web/src/api/hooks.ts:341-360`（`loadMore`）、`:435-458`（`loadOlderLogs`）。
- 重置 effect：`:334-339`、`:427-433`。

### 推荐实现方案

- 调用时快照当前身份（env/筛选/runId 组成的 key），resolve 后比对一致才提交；
  或为分页请求建独立 AbortController，在身份变更的 effect 里 abort。二者择一。

## C2 · Schedules 开关失败静默吞错、401 不上报 {#c2}

### 问题摘要

开关失败只 `.catch(() => rollback)`，不给任何错误提示（对比 RunView 有
`actionError`）；PATCH 返回 401 时未走连接错误上报，连接状态停留在 "Live"
而不是弹出 key 输入。

### 现状证据

- `apps/web/src/screens/Schedules.tsx:16-25`。

### 推荐实现方案

- 加错误展示（对齐 RunView 的 `actionError` 模式）；401 走既有的连接错误上报
  通道，触发 key 输入。

## C3 · 运行中 run 的日志每 2s 被强制拽回底部 {#c3}

### 问题摘要

只要日志条数变化就 `scrollTop = scrollHeight`——运行中的 run，用户向上翻看旧
日志时会被轮询不断拽回底部。

### 现状证据

- `apps/web/src/features/run/RunView.tsx:331-332`。

### 推荐实现方案

- 仅当用户在本次更新前已贴底（`scrollTop + clientHeight >= scrollHeight - ε`）
  时才自动滚动；用户上翻后保持位置。

## 验收标准

- [ ] `bun run typecheck`、`bun run build`（apps/web）通过；相关单测通过。
- [ ] 手动验证：分页在途切 env 不再串数据；开关失败有提示；上翻日志不被拽回。

## 涉及文件

- `apps/web/src/api/hooks.ts`、`apps/web/src/screens/Schedules.tsx`、
  `apps/web/src/features/run/RunView.tsx`
