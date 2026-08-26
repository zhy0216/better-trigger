# P2-09 — 拆分超长文件/函数：runs.ts、claimRuns、scanWaits、main.ts、executor 重复模板

- 优先级：P2（可维护性重构）
- 区域：packages/kernel + apps/worker
- 状态：待办
- 来源：2026-08-26 全仓库审查

> 纯重构：导出面不变、行为不变。每个条目完成后各自 `bun run typecheck` + 相关测试，且必须证明 diff 无行为变化（重构前跑一次基线测试）。

## C1 · `runs.ts`（2577 行）按分节拆分 {#c1}

### 问题摘要

单文件混合 8 个关注点（create/queue/steps/terminal/logs/read/wait/并发计数），多函数超 100 行（createRunsInBatch 863-1036、appendLogs 2180-2297）。文件内分节注释缓解了部分，但导航/review 成本已偏高。

### 现状证据

- `packages/kernel/src/runs.ts` 整文件 2577 行。

### 推荐实现方案

- 按既有分节拆 runs-create / runs-steps / runs-terminal / runs-logs / runs-read，共享 helper 放 runs-internal.ts，导出面不变。

## C2 · `claimRuns`（约 315 行）拆分 {#c2}

### 问题摘要

`claimRuns` 单函数约 315 行：per-namespace 循环 × advisory-lock/计数/flip/lease/stale 处理 + phase 2 账本读取，嵌套 4 层。

### 现状证据

- `packages/kernel/src/queue.ts:341-655`。

### 推荐实现方案

- 拆 `scanCandidates` / `tryClaimOne`（含 stale 分支 521-555）/ `readLedger` 三个内部函数，行为不变。

## C3 · `scanWaits`（约 290 行）拆分 {#c3}

### 问题摘要

`scanWaits` 约 290 行：phase 1 四个扫描 + phase 2 三个分支全在一个闭包；wait-graph 不变量扫描（416-454）与 due-scan 是不同关注点。

### 现状证据

- `packages/kernel/src/orchestrator.ts:339-630`。

### 推荐实现方案

- phase 1 各扫描抽函数；phase 2 抽 `resumeOneWait`。

## C4 · worker `main.ts`（1246 行）+ executor 重复模板抽取 {#c4}

### 问题摘要

`main.ts` 承载四种职责：help 渲染、CLI 解析（parseArgs/parsePruneArgs 两段平铺 switch 高度对称）、退出路径、boot 编排。`executor.ts` 中 `cached()` 三段高度重复的 AbortError 长消息模板 + onReplayDrift 又一段；`assertSignalNotSwallowed` + abandoned + assertNotNested + nextSeq 前言在 doStep/doWait/triggerAndWait/durableBatchTrigger/doDeterministic 重复五次。

### 现状证据

- `apps/worker/src/main.ts` 整文件。
- `apps/worker/src/executor.ts:478-484,499-507,521-528,594-601,697-700` 等。

### 推荐实现方案

- 拆 cli.ts（解析+usage）与 shutdown.ts（handoff/crash/shutdown）。
- 抽 `replayDriftError(seq, what, detail)` 工厂与 `beginPrimitive(what)` 返回 seq 的前言助手。

## 验收标准

- [ ] 各文件拆分后导出面、行为、`git diff` 语义等价不变。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/kernel/src/runs.ts`、`queue.ts`、`orchestrator.ts`
- `apps/worker/src/main.ts`、`executor.ts`