# P2-11 — worker 低挂果：租约滞留、env 重读、模板重复、限流/审计归类、Bearer 大小写、handoff 顺序

- 优先级：P2（正确性/可维护性打磨）
- 区域：apps/worker
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · claim 到未知 task 的 run 租约滞留到过期 {#c1}

### 问题摘要

claim 到 `taskById` 中不存在的 run 时直接 `continue`，租约持有到过期由 reaper 回收（默认最长 ~70s）；上方 stopping 分支已有 releaseClaims 正确示范。

### 现状证据

- `apps/worker/src/runtime.ts:308-313`。

### 推荐实现方案

- 同样 `releaseClaims([run.id])` 立即归还。

## C2 · `stepsTruncated` 错误消息重读 env {#c2}

### 问题摘要

stepsTruncated 失败消息直接重读 `process.env.BETTER_TRIGGER_MAX_STEPS`，而 claim 实际用的 cap 来自 `options.maxSteps`（embedded 模式无 env 来源）。embedded 设 `maxSteps: 500` 时报错仍说 10000，误导排障。

### 现状证据

- `apps/worker/src/executor.ts:250`。

### 推荐实现方案

- cap 经 runtime → Executor 构造器传入。

## C3 · `cached()` AbortError 长消息模板重复 {#c3}

### 问题摘要

三段高度重复的 AbortError 长消息模板 + onReplayDrift 又一段；改文案要改四处。

### 现状证据

- `apps/worker/src/executor.ts:478-484,499-507,521-528,594-601`。

### 推荐实现方案

- 抽 `replayDriftError(seq, what, detail)` 工厂（见 p2-09 C4）。

## C4 · `intQuery` clamp 分支返回 fallback 而非 clamp 值 {#c4}

### 问题摘要

`intQuery` `onInvalid:'clamp'` 分支返回 clamp 后的 fallback 而非 clamp 后的解析值：`?timeoutMs=-5` 得 5000 而非 0；runs.ts 注释声称「out-of-range is silently clamped」与实际（低端回 fallback）不符。

### 现状证据

- `apps/worker/src/http.ts:93` vs `apps/worker/src/runs.ts:78`（或对应注释位置，以实际为准）。

### 推荐实现方案

- 低端越界 clamp 到 min，或修正注释。

## C5 · `PATCH /schedules/:id` 落入宽松读桶、审计不带 id {#c5}

### 问题摘要

PATCH /schedules/:id 是控制面写操作（enable 会触发 run 发射）却落入宽松 read 桶；审计侧 endpoint=null，调度变更不携带对象 id。

### 现状证据

- `apps/worker/src/rate-limit.ts:75-85`、`apps/worker/src/audit.ts:121`。

### 推荐实现方案

- PATCH /schedules 显式归类写桶；审计补充 scheduleIds。

## C6 · Bearer scheme 大小写敏感 {#c6}

### 问题摘要

`header.startsWith('Bearer ')` 大小写敏感；RFC 7235 scheme 大小写不敏感，`bearer xxx` 被误判 401。

### 现状证据

- `apps/worker/src/middleware.ts:223`。

### 推荐实现方案

- 前缀匹配转小写。

## C7 · dashboard.ts PATCH /schedules 手写 404 {#c7}

### 问题摘要

PATCH /schedules 的 404 手写 `c.json(...)` 而非抛 `KernelError('not_found')`，与同文件其他路由（注释自称 not_found 走 onError）风格不一。

### 现状证据

- `apps/worker/src/routes/dashboard.ts:470`（或近邻，以实际为准）。

### 推荐实现方案

- 统一抛 KernelError。

## C8 · handoff 顺序：waiters.stop() 排在 drain 之后 {#c8}

### 问题摘要

handoff 顺序 worker.stop()（最长 30s drain）排在 waiters.stop() 前，而 waiters.stop() 才是拒绝挂起 /result 长轮询的步骤 → 关停时长轮询客户端要等完整个 drain 才被拒。

### 现状证据

- `apps/worker/src/main.ts:704-720`。

### 推荐实现方案

- server.close() 后立即 waiters.stop()，再 drain worker。

## 验收标准

- [ ] 每项改动后 `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `apps/worker/src/runtime.ts:308-313`
- `apps/worker/src/executor.ts:250,478-601`
- `apps/worker/src/http.ts:93`、`runs.ts:78`
- `apps/worker/src/rate-limit.ts:75-85`、`audit.ts:121`
- `apps/worker/src/middleware.ts:223`
- `apps/worker/src/routes/dashboard.ts`
- `apps/worker/src/main.ts:704-720`