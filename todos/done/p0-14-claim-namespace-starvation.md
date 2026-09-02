# P0-14 — 多 namespace claim 扫描：第一个 namespace 可永久饿死其余

- 优先级：P0（正确性 / 活性）
- 区域：packages/kernel
- 状态：已完成（2026-09-02，采用方案 2「顺序轮转」，见文末完成记录）
- 来源：2026-09-02 全仓库审查（第二轮）

## 问题摘要

`claimRuns` 的 per-namespace 扫描共享同一个 `limit` 且按 `namespaces` 数组顺序
先到先得：一旦排第一的 namespace 把配额填满，`if (remaining <= 0) break` 直接结束。
只要 `namespaces[0]` 持续有待认领的 run，后面的 namespace **一次都不会被扫描**，
其 run 无限期不执行。代码注释把这个行为当中性事实描述，但饥饿后果没有任何缓解或观测。

## 现状证据

- `packages/kernel/src/queue.ts:343-346`：
  `for (const ns of args.namespaces) { const remaining = args.limit - pending.length; if (remaining <= 0) break; ... }`。
- 同函数注释（~:330-342）自述：「once a namespace's claims fill it, scanning stops
  and later namespaces never get a scan」。
- 无任何指标暴露「某 namespace 的扫描被跳过」。

## 不变量

- 多进程/多 namespace 部署下，每个被服务的 namespace 都必须有非零的执行机会；
  活跃配额不得被单一 namespace 永久独占。

## 推荐实现方案

- 两选一（实现时择一并写明理由）：
  1. **保底配额**：每轮先给每个有候选的 namespace 各保底 1 个名额，再按顺序分配剩余；
  2. **顺序轮转**：每次 `claimRuns` 调用轮转 `namespaces` 的扫描起点（起点状态放
     runtime/executor 侧，kernel 保持纯函数——例如接受一个 `rotateFrom` 入参）。
- 若改动引入了「扫描被跳过」的概念，加一个计数器/指标（对齐现有
  `claim_errors` 等观测口径）。
- 不改锁序、不改 `FOR UPDATE SKIP LOCKED` 语义；更新函数头注释，删除或改写
  「later namespaces never get a scan」的中性描述。

## 验收标准

- [x] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。
- [x] 新增单测/真 PG 用例：两个 namespace、`namespaces[0]` 有 ≥2×limit 的待领
  run 时，`namespaces[1]` 的 run 仍能在有限轮内被认领。
- [x] 既有 claim 相关 acceptance（e2e / concurrency / rolling-deploy）不回退。

## 涉及文件

- `packages/kernel/src/queue.ts`（调用方 `apps/worker/src/runtime.ts` 若需传入轮转参数）

## 完成记录（2026-09-02）

- **选择方案 2（顺序轮转）**。理由：worker 的实际调用是每 slot `limit: 1`（runtime
  claimLoop），方案 1 的「每个有候选的 namespace 保底 1 个名额」在 ≥2 个 namespace
  下必然突破 `limit`，破坏「单次 claim 至多领 limit 个」的预算语义；轮转不改 limit
  语义，且任何 namespace 至多被跳过 `namespaces.length - 1` 轮。
- 落地：`ClaimRunsArgs` 新增 `rotateFrom?: number`（任意整数，归一化进
  `[0, namespaces.length)`；缺省 = 0 = 历史数组序，纯函数、状态在调用方）与
  `onScanSkipped?: (skipped: readonly Namespace[]) => void`（预算耗尽时报告本轮未被
  扫描的 namespace 尾部，仅观测用）。「扫描被跳过」是既有概念而非本次引入，但
  runtime 侧把它接到了与 claim 错误同一口径的 throttled `log.warn`
  （key `claim:scan-skipped`，每窗口一行）。
- `apps/worker/src/runtime.ts`：所有 slot 共享一个 `claimRotation` 计数器，每次
  `claimRuns` 调用前取值并 +1（模 `namespaces.length`），单 namespace 时恒为 0。
- 锁序与 `FOR UPDATE SKIP LOCKED` 语义未动；`scanCandidates` 与 `claimRuns`
  头注释中「later namespaces never get a scan」的中性描述已改写为轮转下的有界跳过。
- 测试：`packages/kernel/test/claim-rotation.test.ts`（stub，无 PG；含「无轮转则饿死」
  的对照用例与有界性断言）、`packages/kernel/test/pg/claim-namespace-fairness.test.ts`
  （真 PG：ns[0] 4×limit 积压、ns[1] 1 个 run，轮转第 2 轮即认领；对照轮确认无轮转时
  第 3 轮仍在饿死且 ns[1] 的 run 保持 queued 不丢失）、
  `apps/worker/test/runtime-claim-rotation.test.ts`（rotateFrom 逐次轮换 + 跳过告警限流）。
