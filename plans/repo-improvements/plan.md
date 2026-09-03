# Plan: repo-improvements（第三轮全仓库探索）

## 探索结论摘要

无任务 prompt，进入 repo 探索模式。本仓库此前已完成两轮全仓库审查（`todos/done/` 共 20 条，覆盖 env 校验、心跳重入、schema 漂移守卫、namespace 隔离、claim 饥饿轮转、配置校验、LISTEN 重连、日志背压、dashboard 竞态、a11y、ESLint/CI 工具链等）。本轮为第三轮系统性排查。

基线校验全部通过：

- `bun run typecheck` ✅（14 tasks）
- `bun run build` ✅
- `bun run lint` ✅ 但有 **4 条 warning**（未使用的 `prefer-const` eslint-disable：`apps/worker/src/notify.ts:87,89`、`apps/worker/test/executor-swallowed-signal.test.ts:163,281`）
- `bun run test` ✅（443 tests，12 packages）
- `bun run check:deps` ✅ / `bun run check:drift` ✅
- `bun audit` 不可用（npmmirror registry 无 advisory 端点，404）——依赖安全审计无法在本地执行，记录为环境限制
- 全仓库无 `TODO`/`FIXME`/`XXX`/`HACK` 注释

本轮通过 4 个并行深度审查（kernel+db / worker / sdk+core+testing / web+docs+CI）共发现 **70+ 条新问题，无 P0**。前两轮已把危险面（数据丢失、隔离失效、竞态）清理得很干净，本轮以 P1 健壮性/正确性 + 大量 P2 硬化打磨为主。所有关键发现均已抽查源码核实。

## 目标 / 非目标

**目标**：修复本轮发现的全部非 roadmap 问题，按 `todos/` 队列逐条落地；每条有验收测试；全程保持 `typecheck + lint(0 warning) + build + test` 绿。

**非目标**：不动前两轮已修复的行为；不做 roadmap 级新特性（events / fan-out 闭环 / agent 层 / plugin，见文末）；不升级依赖；不重构未涉及模块。

## 方案

按"文件/模块不相交才可并行"原则拆成 11 个任务文件，形成 7 条并行轨道：

1. **01 core/sdk 类型洞与校验**（3 个 P1：`serializeError` 非全函数、`concurrency.limit` 零值静默饥饿、batch 级 options 静默丢弃）
2. **02→04→05 kernel 链**（共享 `queue.ts`/`workers.ts`/`runs-steps.ts`/`orchestrator.ts`，必须串行）：校验边界 → cron 投毒/接管守卫 → 时钟/自愈/质量
3. **03 db 迁移**（FK 索引、workers 部分索引、缺失 CHECK）
4. **06/07 worker 双轨**（API/CLI 与 runtime/executor 文件不相交）
5. **08/09 web 双轨**（通用健壮性 与 Schedules 屏幕文件不相交）
6. **10 testing 包**（harness 缺陷 + 补单元测试）
7. **11 工具链/CI/文档**

### 高价值发现（P1）速览

| 发现 | 位置 | 后果 |
|------|------|------|
| `serializeError` 对 BigInt/循环引用抛异常、对 `undefined`/Symbol 返回 `message: undefined` | core/src/errors.ts:116-121 | 用户 throw 这类值时失败上报路径自身崩溃，run 烧完 recoveries 预算、最终以误导性 WorkerLostError 收场 |
| `task({ concurrency: { limit: 0 } })` 不校验 | sdk/src/task.ts:250-262 | 内核 `running >= limit` 永远成立 → 该任务永久不可调度，无任何报错 |
| `batchTrigger(items, options)` 类型为完整 `TriggerOptions`，实际只取 projectId/env | sdk/src/instance.ts:115 + routes/trigger.ts:44 | `delay`/`priority`/`idempotencyKey` 类型检查通过后被静默丢弃（与 p2-19 同类，另一层级） |
| `prune({ batchSize: 0 })` 死循环 | kernel/src/prune.ts:207-215 | `LIMIT 0` → `0 < 0` 恒假 → 永久占用池连接，retention 永不再跑 |
| 缺 FK 支撑索引 | db schema（0010 把所有索引加 `(project_id, env)` 前缀） | prune 级联删除对 logs/waits/runs/retry_operations 逐行 seq scan，retention 开启时 O(删除数×表大小) |
| 一条毒 cron schedule 停摆整个调度器 | kernel/src/orchestrator.ts:725-883 | `nextCronAt` 抛错 → 整事务回滚 → 所有到期 schedule 永不推进 |
| dashboard `request()` 无 fetch 超时 | web/src/api/client.ts:94-104 | 一个挂起请求永久杀死轮询循环，UI 冻结且连接状态不回退 |
| Ruler 每秒一个 tick div | web/src/features/run/RunView.tsx:125-128 | 24h wait 的 run → 86400 个 div，每 2s 轮询重渲染，浏览器卡死 |
| Schedules 乐观覆盖成功后永不清除 | web/src/screens/Schedules.tsx:15-34 | 服务端后续变更被本地陈旧覆盖永久压制 |

## 拆解

任务队列见 `todos/`，与下列清单一一对应。完整发现清单（含证据位置）同时保留在各 todo 文件内。

| # | 文件 | 优先级 | 难度 | 依赖 |
|---|------|--------|------|------|
| 01 | 01-core-sdk-type-holes.md | P1 | medium | 无 |
| 02 | 02-kernel-validation-boundaries.md | P1 | medium | 无 |
| 03 | 03-db-fk-indexes-and-checks.md | P1 | medium | 无 |
| 04 | 04-kernel-cron-poison-and-takeover.md | P1 | hard | 02 |
| 05 | 05-kernel-quality-clock-selfheal.md | P2 | hard | 04 |
| 06 | 06-worker-api-cli-hardening.md | P2 | medium | 无 |
| 07 | 07-worker-runtime-executor-hardening.md | P2 | medium | 无 |
| 08 | 08-web-robustness-perf-a11y.md | P1 | medium | 无 |
| 09 | 09-web-schedules-reconciliation.md | P1 | medium | 无 |
| 10 | 10-testing-package-harness.md | P2 | medium | 无 |
| 11 | 11-toolchain-ci-docs.md | P2 | medium | 无 |

可并行轨道：{01} {02→04→05} {03} {06,07} {08,09} {10} {11}。

## 校验

- 仓库级：`bun run typecheck` → `bun run lint`（本轮要求 **0 warning**）→ `bun run build` → `bun run test`
- 辅助：`bun run check:deps`、`bun run check:drift`（03 改 schema 必跑）、`bun run check:exports`（01 改 sdk 导出后跑）
- kernel/worker 条目若触及并发/回滚/通知路径（04、05、06 的 waiter 改动）：设置 `DATABASE_URL` 后在真 PostgreSQL 下复跑 `bun run test` + `bun run test:acceptance`

## 风险与假设

- **假设**：`apps/worker/src/generated/build-info.ts` 的未提交改动是构建脚本生成的 SHA 戳（本会话跑 `bun run build` 产生），非用户改动；提交计划文件时一并还原。
- **假设**：次要歧义按最保守语义处理（如 `waitForResult` 的 `Infinity` 显式文档化而非禁止；`--database-url` 保留但警告而非删除）。
- **风险**：05 的 wait-graph 自愈与 DB 时钟改造触及并发核心路径，须严格走锁序 + 真 PG 测试；若实现中发现语义冲突，允许降级为"仅记录不自愈 + 文档化"，但需在 commit 中说明。
- **风险**：03 的索引迁移在大表上创建耗时，migration 使用 `CREATE INDEX CONCURRENTLY` 不可行（事务内），按现有 migration 风格普通创建即可（本库体量可接受），但在 migration 注释中写明。
- **环境限制**：`bun audit` 因 registry 不支持而不可用，依赖漏洞审计跳过。

## Roadmap（只进 plan，不进队列）

沿用第二轮确认的缺口，规模超出条目粒度：

- **P3 events**：`event()` / `emit` / `wait.forEvent` + `events` 表
- **P3 fan-out 闭环**：`batchTriggerAndWait` + cancel 父→子级联
- **P2 尾**：持久化边界故障注入 harness（连接中断/重复投递）
- **P3 前置**：testing 包虚拟时间（本轮 10 已注入 injectable clock 铺路）
- **P4**：`better-trigger-worker migrate` 子命令
- **P5 agent 层**、**P6 plugin interceptors / eslint-plugin**

## 执行结果（2026-09-03，Herdr Workflow 并行执行）

全部 11 个任务完成并合入 main（`git merge --ff-only`，逐任务 rebase + 协调器独立复核校验）。

| todo | commit | 模型 |
|------|--------|------|
| 01 core-sdk-type-holes | c0940ea | flash |
| 02 kernel-validation-boundaries | a3c67ab | flash |
| 03 db-fk-indexes-and-checks | b2e315d | flash |
| 04 kernel-cron-poison-and-takeover | 033ec80 | max |
| 05 kernel-quality-clock-selfheal | 0b11c03 | max |
| 06 worker-api-cli-hardening | 2fb3daf | flash |
| 07 worker-runtime-executor-hardening | b1cfc53 | flash |
| 08 web-robustness-perf-a11y | d28f0e7 | flash |
| 09 web-schedules-reconciliation | ed958f4 | flash |
| 10 testing-package-harness | 3dee02e | flash |
| 11 toolchain-ci-docs | 93fff79 | flash |

归档：11 个 todo 文件全部移入 `todos/done/`，`todos/README.md` 状态同步更新。

最终校验（协调器在合入后的 main 上独立运行，全绿）：`bun run typecheck`（14/14）、`bun run lint`（9/9，**0 warning**——既有 4 条 worker 由 11 清零、1 条 web react-refresh 由 08 顺带修复）、`bun run build`（7/7）、`bun run test`（13/13 含首次入列的 testing 包）、`check:deps` / `check:drift` / `check:exports`。kernel 的 04/05 与 03 的迁移均在隔离真 PG 容器下复跑通过（05 的 94 个真 PG 用例含新增 clock-skew 套件）。

过程记录：
- 05 的 OpenCode 进程在实现中途崩溃一次，通过会话恢复（`-s`）续接完成，工作未丢失；累计时长因此超出 2 小时常规阈值，属崩溃恢复而非失控，特此说明。
- 探索期记录的"4 条 lint warning"实为 5 条（另有 `RunView.tsx:321` react-refresh），由 08 在其文件范围内顺带清零。
- 协调器曾观察到共享 PG（localhost:5432）上既有 `pg/cron-skew.test.ts` 在干净 main 即失败（宿主钟与容器钟漂移）；05 的 T1（写路径 DB 时钟）落地后该用例转绿。
- 04 的一个已知语义决策：被投毒但仍有服务的 cron schedule 会先触发当次合法到期的 run 再被 NULL 隔离（在 todo 允许的处置范围内）。
- 10 遗留提示：`fencing.ts:452` 一条 NOTE 描述已过时（对象 reader 现已支持 namespace），因越界未改。

无 blocked / deferred 项；本轮创建的全部 Herdr workspace、worktree 与任务分支已清理。
