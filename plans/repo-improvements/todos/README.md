# repo-improvements TODOs — 第三轮全仓库探索（2026-09-03）

第三轮系统性排查的发现队列（前两轮 20 条已归档于仓库根 `todos/done/`）。基线：typecheck / build / lint（4 warning）/ test（443）全绿，无 TODO/FIXME 注释。本轮无 P0；P1 集中在"静默错误语义"（校验缺口、类型洞、单点投毒、轮询挂死）与缺失索引。

## 优先级

| # | 文件 | 优先级 | 难度 | 一句话 |
|---|------|--------|------|--------|
| 01 | [01-core-sdk-type-holes.md](./done/01-core-sdk-type-holes.md) | P1 | medium | ✅ 已完成 · serializeError 非全函数、concurrency.limit 零值静默饥饿、batch/triggerAndWait options 类型洞，外加 SDK 校验与导出补齐 |
| 02 | [02-kernel-validation-boundaries.md](./done/02-kernel-validation-boundaries.md) | P1 | medium | ✅ 已完成 · prune batchSize:0 死循环，及 waitForResult/claimRuns/registerWorker/worker 输入/心跳零行等内核校验边界 |
| 03 | [03-db-fk-indexes-and-checks.md](./done/03-db-fk-indexes-and-checks.md) | P1 | medium | ✅ 已完成 · 缺 FK 支撑索引导致 prune 级联 seq scan；workers 部分索引；trigger_type/trigger_source 缺 CHECK（迁移 0016：5 个 `*_fk_idx` + logs_run_id_idx 改 run_id 打头避免重复索引 + workers 在线部分索引 + 两个 trigger 枚举 CHECK） |
| 04 | [04-kernel-cron-poison-and-takeover.md](./04-kernel-cron-poison-and-takeover.md) | P1 | hard | 依赖 02。单条毒 cron 停摆全调度器；C4 接管守卫对旧版 manifest 失明；batchTriggerChild 孤儿 run；served 语义分裂 |
| 05 | [05-kernel-quality-clock-selfheal.md](./05-kernel-quality-clock-selfheal.md) | P2 | hard | 依赖 04。宿主时钟 vs DB 时钟、wait-graph 检出不自愈、work 通知跨 namespace 唤醒、死代码/注释/契约文档漂移 |
| 06 | [06-worker-api-cli-hardening.md](./done/06-worker-api-cli-hardening.md) | P2 | medium | ✅ 已完成 · CORS 缺 Idempotency-Key、GET /runs 游标毫秒截断丢行、CLI 上限缺失、--help 被 env 校验拦截、waiter 监听器泄漏、`--database-url` 凭据暴露未警示（T1–T7 全部落地） |
| 07 | [07-worker-runtime-executor-hardening.md](./done/07-worker-runtime-executor-hardening.md) | P2 | medium | ✅ 已完成 · ctx.wait 确定性参数错误被可重试化、startWorkerRuntime 库 API 跳过校验、背压日志打 "undefined"、静态资源整体缓冲、shebang 仅注入 bin、engines/target 对齐（T1–T5 全部落地） |
| 08 | [08-web-robustness-perf-a11y.md](./08-web-robustness-perf-a11y.md) | P1 | medium | fetch 无超时杀死轮询、Ruler DOM 无界增长、Sparkline NaN、chevronUp 缺失、错误边界、a11y 与 key 修补 |
| 09 | [09-web-schedules-reconciliation.md](./09-web-schedules-reconciliation.md) | P1 | medium | Schedules 乐观覆盖永不清除 + 并发点击竞态 + Switch 缺可访问名 |
| 10 | [10-testing-package-harness.md](./10-testing-package-harness.md) | P2 | medium | testing 包 10 处缺陷（超时/泄漏/孤儿进程/URL 解析）+ 注入式时钟与单元测试从零补齐 |
| 11 | [11-toolchain-ci-docs.md](./11-toolchain-ci-docs.md) | P2 | medium | 4 条 lint warning、root scripts 零 lint 覆盖、CI turbo 缓存与 SHA pin、docs PR 门禁、docker-compose PG 暴露、文档漂移 |

## 文件

执行顺序（从高到低；同一轨道内串行，轨道间文件不相交可并行）：

1. `01-core-sdk-type-holes.md`（P1）✅ 已完成，归档至 `done/`
2. `02-kernel-validation-boundaries.md`（P1）✅ 已完成，归档至 `done/`
3. `03-db-fk-indexes-and-checks.md`（P1）✅ 已完成，归档至 `done/`
4. `04-kernel-cron-poison-and-takeover.md`（P1）— 依赖 02（共享 queue.ts / workers.ts / runs-steps.ts）
5. `05-kernel-quality-clock-selfheal.md`（P2）— 依赖 04（共享 orchestrator.ts / runs-logs.ts 等）
6. `06-worker-api-cli-hardening.md`（P2）✅ 已完成，归档至 `done/`
7. `07-worker-runtime-executor-hardening.md`（P2）✅ 已完成，归档至 `done/`
8. `08-web-robustness-perf-a11y.md`（P1）
9. `09-web-schedules-reconciliation.md`（P1）
10. `10-testing-package-harness.md`（P2）
11. `11-toolchain-ci-docs.md`（P2）

可并行轨道：{01} {02→04→05} {03} {06,07} {08,09} {10} {11}。

## 执行约定

- 一次只推进一个文件；完成后跑仓库级校验并归档。
- 每个条目只动要求的代码；不顺手重构、不升级依赖。
- 04/05 涉及并发路径：实现前先读 `docs/architecture.md` 的锁序约定，真 PG（设置 `DATABASE_URL`）下复跑相关套件。
- 本轮验收要求 `bun run lint` **0 warning**（01-10 不得新增，11 负责清零既有的 4 条）。

## 基线校验

- `bun run typecheck` → `bun run lint` → `bun run build` → `bun run test`（全绿才 commit）
- 改 schema：加跑 `bun run check:drift`；改发布包导出：加跑 `bun run check:exports`
- kernel/worker 触及并发/回滚/通知路径：设置 `DATABASE_URL` 后复跑 `bun run test`（真 PG 套件自动启用）
