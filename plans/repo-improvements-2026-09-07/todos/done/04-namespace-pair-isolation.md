difficulty: hard
agent: inherit

# cron 与指标的 namespace pair 隔离

对应 F7–F8。优先级 P1。前置依赖：无。修内部 pair 身份，不改 CLI 格式，不禁止合法斜杠，不改 SQL advisory lock 协议。

## T1 · cron 的服务能力查询按无歧义二元组分组

- 要做什么：修复 `startOrchestrator` 中 dueNs 的斜杠拼接 key，使每组 servedTaskIds 查询使用确切 projectId/env。检查相关 in-memory identity key，区分身份键与仅供显示的文本。
- 预计修改：`packages/kernel/src/orchestrator.ts`；`packages/kernel/test/cron-unserved.test.ts`、`packages/kernel/test/pg/cron-unserved.test.ts` 或同目录独立 namespace 回归。
- 验收：使用 `{projectId:'a/b',env:'c'}` 与 `{projectId:'a',env:'b/c'}`、相同 task id，仅一组有 online worker 时只该组创建 cron run；另一组计入 skippedUnserved 并正常推进 next_run_at。换序、恢复 worker、空队列场景保持隔离。真实 PG 必须验证，保留现有锁序、DB clock、poison isolation。
- 前置依赖：无。

## T2 · 指标中的 namespace series 不碰撞

- 要做什么：修复 `queryGauges` 的 Map 初始化和查询键，保证不同 namespace pair 不相互覆盖。
- 预计修改：`apps/worker/src/routes/metrics.ts`、`apps/worker/test/metrics.test.ts`。
- 验收：上述两组 available=3/7 都输出正确的独立 series；空组输出自己的零值；请求顺序不影响标签和值。namespace/assertNamespace 合法输入继续接受，不用减少支持范围解决问题。
- 前置依赖：无。

验证：`bun run --cwd apps/worker test -- test/metrics.test.ts`、kernel cron/namespace 相关测试和独占 PG 回归，随后完整仓库 gate。后续 05/06 会分别修改 metrics/orchestrator，完成后先复核集成，不能并行抢改文件。一个最终 commit。

## 完成记录 · 2026-09-07

本任务在 `herdr/plan-repo-20260907-04-namespace` 完成，基点 `ba0b9b8`。只修改下列五个源码/测试文件、本归档和 README 的 04 行；未执行 roadmap，未改 CLI、namespace 校验、SQL advisory lock 协议、依赖或 plan.md。等待协调器复核集成后开放 05/06。

- `packages/kernel/src/orchestrator.ts`：dueNs 改用 JSON 二元组键；未服务任务集合用编码后的 namespace/task 三元组判断变化，斜杠文本只用于日志展示。
- `packages/kernel/test/cron-unserved.test.ts`：两种 namespace 顺序下验证精确 servedTaskIds 参数、单组触发、skip 写回、通知、worker 切换/恢复和空扫描；用 fake timers 控制每个 tick。
- `packages/kernel/test/pg/cron-unserved.test.ts`：真实 PG 中分别注册同 id 的两个 cron task/worker，验证两种顺序下的隔离、恢复、计数与数据库时钟写回。
- `apps/worker/src/routes/metrics.ts`：Map 初始化和查询均使用 JSON 二元组键。
- `apps/worker/test/metrics.test.ts`：两种配置顺序、反向 SQL 行顺序、连续 scrape、单组/双组空队列和恢复；验证 core/host 边界仍接受两组合法斜杠输入。

## 逐条验收

- [x] T1：A=`{projectId:'a/b',env:'c'}`、B=`{projectId:'a',env:'b/c'}`、相同 task id，A 在线/B 离线时 run/queue 数为 1/0，skippedUnserved=1；B 的 next_run_at 在数据库时钟的未来，last_run_* 仍为 NULL。
- [x] T1：两种 namespace 顺序都通过。切换为 B 在线/A 离线后 run/queue 数为 1/1、skip=2，A 的既有 last_run_* 保持；恢复两组 worker 后为 2/2、skip 仍为 2。初始空队列及后续空 due 扫描不产生额外 run 或 skip。
- [x] T1：stub 验证每组 servedTaskIds 只携带自己的原始 pair 和同一 task id；通知只发给实际触发的 namespace。相同未服务集合不重复告警，未服务任务在两组间切换时产生新告警，恢复时告警一次。
- [x] T1：已检查其余内存身份键。cron/reaper 的通知去重使用 NUL 分隔，输入来自 PG text，合法存储值不能含 NUL，斜杠不会碰撞；byChild 使用全局唯一 run id；wait-graph 签名的两部分是计数。保留这些现有路径。SQL、锁序、DB clock 和 poison 路径无修改，原有对应单测与真实 PG 回归通过。
- [x] T2：每次 scrape 两个 namespace 都各有 3 个 queue state series 和 1 个 inflight series；available=3/7，scheduled=2/6，claimed=1/5，inflight=1/5。SQL 行顺序和 namespace 配置顺序反转均保持标签和值；任一空组及全空结果都输出各自零值，后续数据恢复正常。
- [x] T2：`assertNamespace` 和 `namespaceFromOptions` 继续接受上述两组输入，既有 namespace 路由与 CLI 回归通过，支持范围未缩小。
- [x] 仓库 gate 全通过：156 files / 1,601 tests，较 1,594 基线新增 7 tests；kernel 59 files / 439 tests。真实 PG 共 102 tests（kernel 的 test/pg/ 24 files / 99 tests、retry-policy-validation 的 1 项 PG test、testing/database.pg 的 2 tests），无 suite/test skip。

## 验证命令与日志

日志目录：`/tmp/bt-04-namespace-D2dJyZ`。每次执行使用不同文件名，保留失败原文。PG 命令经该目录的 `with-pg.ts` 包装：`bun <目录>/with-pg.ts <日志前缀> bun ...`。包装器用 mkdtemp、随机 loopback 端口及合成用户创建 PostgreSQL 16 cluster，显式传入 DATABASE_URL，在 finally 中停止并清理；Turbo 的 test.env 包含 DATABASE_URL。三次 PG 执行均有成功 stop 日志，所建 cluster 已移除。

| 命令 | 结果 / 日志 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过；Bun 1.4.2，588 packages；01-install.log |
| `bun run build -- --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/testing` | 4/4 命中 Turbo 缓存；仅依赖准备，不作为验证证据；02-build-test-dependencies.log |
| `bun run build -- --force --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/testing` | 随即在本 worktree 强制重建，4/4、0 cached；03-build-test-dependencies-force.log |
| `bun run --cwd apps/worker test -- test/metrics.test.ts`（修复前） | 28 passed / 2 failed，预期回归失败；04-metrics-red.log |
| `bun run --cwd packages/kernel test -- test/cron-unserved.test.ts`（修复前） | 2 passed / 2 failed，预期回归失败；05-cron-unit-red.log |
| `bun run --cwd packages/kernel test -- test/pg/cron-unserved.test.ts`（独占 PG，修复前） | 2 passed / 2 failed，无 skip；06-cron-pg-red-test.log |
| `bun run --cwd packages/kernel test -- test/cron-unserved.test.ts`（只修 dueNs 后） | 2 passed / 2 failed，捕获告警签名碰撞；07-cron-signature-red.log |
| `bun run --cwd apps/worker test -- test/metrics.test.ts test/namespace-routes.test.ts test/namespace-cli.test.ts` | 3 files / 51 passed；08-worker-targeted-green.log |
| 下方 kernel 局部命令（独占 PG） | 11 files / 80 passed，无 skip；09-kernel-targeted-green-test.log |
| `TURBO_FORCE=true bun run lint` | 9/9 tasks，0 cached；10-root-lint.log |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks，0 cached；11-root-typecheck.log |
| `TURBO_FORCE=true bun run build` | 7/7 tasks，0 cached；12-root-build.log |
| `bun run test -- --force`（独占 PG） | 首次运行通过：13/13 tasks，0 cached，156 files / 1,601 passed，无 skip；13-root-tests-pg-test.log |
| `git diff --check` | 通过；14-diff-check.log；归档后再次检查 |

kernel 局部命令：

```sh
bun run --cwd packages/kernel test -- \
  test/cron-unserved.test.ts test/namespace-isolation.test.ts \
  test/registration-cron.test.ts test/orchestrator.test.ts \
  test/orchestrator-counters.test.ts test/orchestrator-cron-poison.test.ts \
  test/notify.test.ts test/pg/cron-unserved.test.ts \
  test/pg/cron-skew.test.ts test/pg/cron-poison.test.ts \
  test/pg/claim-namespace-fairness.test.ts
```

## 失败保留与边界

- 修复前 metrics 两种顺序都只输出 3 个 queue series，断言 expected length 6 but got 3；cron stub 只查询一个 pair，真实 PG 正序误为未服务 B 创建一个 run，反序则使已服务 A 没有 run。以上失败均保留，随后改为二元组身份并通过。
- 只修 dueNs 后，未服务任务从 B 切换到 A 仍只有一次告警，断言 expected length 2 but got 1；改用三元组集合签名后通过。没有通过重跑掩盖该失败。
- 本任务根 gate 首次全通过。计划中已有的复制反馈首次失败 `AssertionError: expected '' to be 'Copied' // Object.is equality`、后续 1,594 tests 复核通过及 acceptance 19/19 基线记录完整保留在未修改的 plan.md。本任务 root runView.test.tsx 的 5 tests 通过，不据此声称修复 F17；该问题仍由 08 处理。
- 保留已有构建警告：`WARN TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.` 未升级依赖。
- 本任务未重跑最终集成专属 acceptance/check:*；19/19 是计划基线，由协调器最终集成复核。本任务无剩余验收 blocker；05/06 必须在本任务复核集成后执行。

## 集成复核 · 2026-09-08

收到协调器持有集成锁的通知后，在当前任务分支执行 `git rebase main`，基点更新为 `95110a82e1e7aaa0a560470184b55c9503ebba69`（已合入 09、02、01）。rebase 自动完成，无冲突；五个源码/测试文件与 rebase 前任务 commit `8b9570e243b8a589b72f92347bca57353e2f4e55` 完全一致，无需代码修复。README 除本任务 04 行外与 main 完全一致，01/02/09 已完成行和其他任务状态均保留；任务范围之外的上游代码及 plan.md 与 main 一致。复核后仅追加本节、更新 README 的 04 行并 amend 原任务 commit，仍为 main 之上的一个任务 commit。

本次独立日志目录：`/tmp/bt-04-namespace-integration-1g0h0j`；原 `/tmp/bt-04-namespace-D2dJyZ` 的首次回归失败及后续通过日志全部保留。本次各项校验首次执行均通过，没有新增失败。

| 命令 | 集成后结果 / 日志 |
| --- | --- |
| `git rebase main` | 无冲突；01-rebase.log |
| `bun run build -- --force --filter=@better-trigger/kernel --filter=better-trigger --filter=@better-trigger/testing` | 当前 worktree 强制重建依赖，4/4 tasks，0 cached；02-build-test-dependencies.log |
| `bun run --cwd apps/worker test -- test/metrics.test.ts test/namespace-routes.test.ts test/namespace-cli.test.ts` | 3 files / 51 passed；03-worker-targeted.log |
| 上方 kernel 局部命令（独占 PG） | 11 files / 80 passed，无 skip；04-kernel-targeted-test.log |
| `TURBO_FORCE=true bun run lint` | 9/9 tasks，0 cached；05-root-lint.log |
| Git 分支、文件边界及 README 内容审计（Bun 执行） | main 未变，父提交等于 main，仅一个任务 commit；五个源码/测试文件与 rebase 前一致；其他 README 内容逐字保留；06-integration-audit.log |
| `TURBO_FORCE=true bun run typecheck` | 14/14 tasks，0 cached；07-root-typecheck.log |
| `TURBO_FORCE=true bun run build` | 7/7 tasks，0 cached；08-root-build.log |
| `bun run test -- --force`（独占 PG） | 13/13 tasks，0 cached；156 files / 1,731 passed，无 skip；09-root-tests-pg-test.log |
| `git diff --check`、`git diff --check main..HEAD` | 通过；10-diff-check-worktree.log、11-diff-check-task.log；amend 后再检查最终状态 |

根测试分项：core 115、db 78、sdk 174、testing 104、web 180、worker 641、kernel 439；比计划基线 1,594 增加 137（已合入 01/02 增加 130，本任务增加 7）。真实 PG 共 102 tests，包括 kernel 的 test/pg/ 24 files / 99 tests、retry-policy-validation 的 1 项 PG test 和 testing/database.pg 的 2 tests。worker 来源检查及 core JSON/诊断边界的新回归均随完整根测试通过；本任务的换序、worker 切换/恢复、空队列及 metrics 独立 series 验收继续满足。

两次 PG 运行分别用 mkdtemp 创建 `/tmp/bt-04-namespace-pg-uJDw8A`、`/tmp/bt-04-namespace-pg-4x67Dp`，各用随机 loopback 端口、合成测试用户并显式传入 DATABASE_URL（Turbo test.env 保留该变量），均在 finally 中成功 stop 并移除；未复用旧 cluster 或用户数据库。已有 TypeScript 7.0 experimental API 警告仍保留。原复制反馈失败、随后 1,594 tests 复核通过和 acceptance 19/19 基线记录未变；本轮 runView 的 5 tests 通过，不据此关闭 F17。最终队列集成的 acceptance/check:* 仍由协调器执行，无本任务验收 blocker。
