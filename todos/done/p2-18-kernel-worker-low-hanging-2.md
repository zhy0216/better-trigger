# P2-18 — kernel 低挂果（第二轮）：孤儿 schedule、LISTEN 竞态、日志背压、观测缺口

- 优先级：P2（健壮性 / 可观测性打磨）
- 区域：packages/kernel、apps/worker
- 状态：已完成（2026-09-02）
- 来源：2026-09-02 全仓库审查（第二轮）

## C1 · 从所有 manifest 移除的 cron task，schedule 永久触发、run 无限堆积 {#c1}

### 问题摘要

task 从所有在线 worker 的 manifest 移除后，`tasks` 行与 `schedule` 行都还在
（引擎从不删 task），cron loop 继续为其创建 run，但没有任何在线 worker 能认领
→ run 永远 `queued`，queue 行不删。无 retention 时 queue/runs 无界增长；默认
配置下完全静默（stranded scan 只在 `--pin-code-version` 下开启）。

### 现状证据

- `packages/kernel/src/workers.ts:340-353`：`syncSchedules` 只处理「仍在 manifest
  但失去 cron」的 schedule。
- `packages/kernel/src/orchestrator.ts:720-755`：`scanCron` 创建 run 不带任务存在性校验。

### 推荐实现方案

- 对「无任何在线 worker 服务」的 task 的 schedule，扫描时跳过并累计一个可观测
  计数/告警（不与 `--pin-code-version` 绑定）；不自动删数据，只止血 + 暴露。

## C2 · LISTEN 重连竞态可能孤儿化一条活的 LISTEN 连接 {#c2}

### 问题摘要

`'error'` 里主动 `end()` 并调度重连，靠 `reconnectScheduled` 去重，依赖 `'end'`
先于重连定时器到达。若旧连接的 `'end'` 延迟到重连完成后才到达，会再调度一次
`connect()`，新 client 覆盖 `client`——之前已建立、正在 LISTEN 的连接被遗弃且
不关闭，每次泄漏一条连接并造成重复通知。

### 现状证据

- `apps/worker/src/notify.ts:140-165`（`scheduleReconnect`、`connect` 覆盖 `client`）。

### 推荐实现方案

- 给连接加代际（generation/序号）标记；`'error'`/`'end'` 回调只在触发者仍是当前
  `client` 时才调度重连，陈旧连接的回调直接忽略并关闭它。

## C3 · executor 日志 flush 无背压，DB 慢时内存膨胀 {#c3}

### 问题摘要

`log()` 每满阈值就 `void this.flushLogs()`，加上 1s 定时器，flush 无在途上限。
若 `appendLogs` 慢，高频日志任务的未落盘日志按「速率 × 慢查询时长」线性堆积在内存。

### 现状证据

- `apps/worker/src/executor.ts:1090-1104`。

### 推荐实现方案

- 限制并发/在途 flush（超过上限时合并或丢弃最旧批次并计入既有错误观测口径），
  或改为串行单飞队列；不改变日志最终一致语义，只加上限。

## C4 · waiter sweep 无重入保护 {#c4}

### 问题摘要

`setInterval(() => void sweep(), pollMs)` 无 running 标志；DB 查询超过间隔时多个
sweep 并发在途。`isPending` 检查保证不会重复 settle，但发冗余查询，且与同仓其它
单飞设计（orchestrator loop、stats inflight gauge）不一致。

### 现状证据

- `apps/worker/src/waiters.ts:305-312`。

### 推荐实现方案

- 加与 orchestrator `loop()` 同款的 running 布尔/单飞包裹。

## C5 · claim loop 两处 `releaseClaims` 失败被静默吞掉 {#c5}

### 问题摘要

stopping 后认领到的 run、未知 task 的 run，两处释放用 `.catch(() => {})`，失败无
日志无计数，run 只能等 reaper，且无任何痕迹。

### 现状证据

- `apps/worker/src/runtime.ts:319-323`、`:332-336`。

### 推荐实现方案

- 接既有 `log.warn` + 错误计数（对齐 `handBack()` 的观测口径）。

## 验收标准

- [x] `bun run typecheck`、`bun run build`、`bun run test` 全部通过；涉及通知/
  调度路径的改动在真 PG 下复跑相关套件（kernel 全套 + test/pg/cron-unserved、
  cron-skew、suspend-notify、smoke 于本机 postgres:16 通过）。
- [x] 不改变既有正确路径行为；新增观测点有对应指标/日志断言。
  - C1：`OrchestratorCounters.cronSkippedUnserved` 计数 + `[orchestrator:cron]`
    转换日志；stub 断言见 `packages/kernel/test/cron-unserved.test.ts`，真 PG
    断言见 `packages/kernel/test/pg/cron-unserved.test.ts`（含 worker 回归在线后
    恢复触发）。
  - C2：`notify.test.ts` 新增 delayed-'end'/stale-'error' 两个竞态用例；既有
    error+end 去重、stop 语义用例不变。
  - C3：慢 appendLogs 下 `maxInFlight == 1`、全量投递 / 溢出 drop-oldest 计入
    `logFlushErrors` 并有 warn 行（`executor-log-backpressure.test.ts`）。
  - C4：`waiters.test.ts` 新增 sweep 不重叠用例。
  - C5：两处 `releaseClaims` 失败经 throttled `log.warn`（`release-claims:` 桶，
    对齐 `handBack()` 口径）并报出（`runtime-logging.test.ts` 两个用例）。

## 涉及文件

- `packages/kernel/src/workers.ts`、`packages/kernel/src/orchestrator.ts`、
  `apps/worker/src/notify.ts`、`apps/worker/src/executor.ts`、
  `apps/worker/src/waiters.ts`、`apps/worker/src/runtime.ts`
