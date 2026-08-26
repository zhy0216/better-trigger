# P2-10 — kernel 低挂果：静默丢弃、API 陷阱、裸 Error、常量重复、注释漂移

- 优先级：P2（正确性/可维护性打磨）
- 区域：packages/kernel
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · `appendLogs` 压不进 batch 的单行静默丢弃 {#c1}

### 问题摘要

`appendLogs` 中无法压进 batch cap 的单行静默丢弃——不进 droppedLines、无 warn，与同函数对 missing/terminal 的仔细观测不一致。

### 现状证据

- `packages/kernel/src/runs.ts:2206-2208`。

### 推荐实现方案

- 加第三种 droppedKind 并 warn，与既有观测口径一致。

## C2 · `enqueueMany` 混合批次的 preserve/overwrite 语义陷阱 {#c2}

### 问题摘要

`enqueueMany` 用 `every(preserveSurvivor)` 决定整批冲突语义，混合批次会静默让 preserve 行走 overwrite 分支。当前调用方不混合，是 API 陷阱。

### 现状证据

- `packages/kernel/src/queue.ts:127-136`。

### 推荐实现方案

- 混合时抛 bad_request，或按语义拆两条 INSERT。

## C3 · 防御分支抛裸 `Error` → 500 {#c3}

### 问题摘要

防御分支抛裸 `Error`，到 API 边界是 500 而非结构化 KernelError。

### 现状证据

- `packages/kernel/src/runs.ts:695,1028,1453`。

### 推荐实现方案

- 换 `KernelError('internal', ...)`。

## C4 · `TERMINAL_STATUSES` 五处独立书写点 {#c4}

### 问题摘要

`['completed','failed','canceled']` 有 5 处独立书写点（加 schema CHECK 是第 6 处），其中 prune.ts 重复定义了 queue.ts 已导出的常量。

### 现状证据

- `packages/kernel/src/queue.ts:245`（导出）、`prune.ts:46`（重复）、`orchestrator.ts:561,801,817`、`runs.ts:1914`（内联）。

### 推荐实现方案

- kernel 内统一 import queue.ts 的 TERMINAL_STATUSES；删 prune.ts:46 重复定义；确认各内联处语义一致后合并，语义不同处保留注释说明。

## C5 · `withTx` 与六处手写 BEGIN/COMMIT 样板 {#c5}

### 问题摘要

`withTx` vs 六处手写 BEGIN/COMMIT 样板（catch-rollback-finally 骨架复制 6 次）。手写各有正当理由（phase-2、REPEATABLE READ、计数器 COMMIT 后折叠）。

### 现状证据

- `packages/kernel/src/runs.ts:383` vs queue.ts:361、orchestrator.ts:634,732、queue.ts:899、workers.ts:75、runs.ts:2419。

### 推荐实现方案

- 给 withTx 加 `isolation?` 参数覆盖 getRunDetail；其余保留但补注「为何不能用 withTx」。

## C6 · prune 候选扫描 `COALESCE(finished_at, updated_at)` 无法用索引 {#c6}

### 问题摘要

prune 候选扫描的 COALESCE 表达式无法用索引，每批在终态行集上过滤+排序。

### 现状证据

- `packages/kernel/src/prune.ts:115-118,231-237`。

### 推荐实现方案

- 低频路径暂可接受；若成问题加 partial index `(project_id, env, finished_at) WHERE status IN (terminal)`。文件头注明权衡即可（可选）。

## C7 · notify.ts 中英混杂注释 + markOfflineWorkers 文档瑕疵 {#c7}

### 问题摘要

notify.ts 有中英混杂注释残留（"PF2 §通道"、"§跨 daemon"），与全库纯英文不一致；markOfflineWorkers 不做 namespace 过滤，与文件头「every loop filters」文档说法不一致（行为正确，worker 心跳是全局概念）。

### 现状证据

- `packages/kernel/src/notify.ts:45,63`。
- `packages/kernel/src/orchestrator.ts:882-890` vs `157-163`。

### 推荐实现方案

- 注释改英文引用；补一句说明 worker 离线标记是全局语义。

## 验收标准

- [ ] 每项改动后 `bun run typecheck`、`bun run build`、`bun run test` 全部通过（涉及 appendLogs/enqueueMany 的在真 PG 下复跑相关套件）。

## 涉及文件

- `packages/kernel/src/runs.ts`、`queue.ts`、`prune.ts`、`notify.ts`、`orchestrator.ts`、`workers.ts`