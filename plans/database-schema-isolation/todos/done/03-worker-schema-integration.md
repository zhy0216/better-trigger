difficulty: medium
agent: inherit

# 03 · worker 查询和 embedded 集成

优先级：P1。依赖 01-db-schema-and-baseline、02-kernel-qualified-sql。独立 worktree，一个最终 commit。

## T1 · 限定 dashboard、stats、metrics 和 waiter SQL

- 要做什么：调整直接读写表的 worker 入口，涵盖任务列表、run/schedule/worker 查询、schedule 更新、统计子查询、queue/runs gauge 和 waiter 单次/批量读取。每个真实表名使用 `better_trigger`，保留参数和 namespace 过滤。
- 预计修改：`apps/worker/src/routes/dashboard.ts`、`routes/metrics.ts`、`stats.ts`、`waiters.ts`。
- 验收条件：dashboard 读写、统计、终态等待和 metrics 均访问目标表；默认业务池和独立 probe pool 都适用；取消/超时/单航班查询等既有行为无回退。
- 前置依赖：01、02 全部完成。

## T2 · 核对 daemon、prune 和 embedded 的池与迁移入口

- 要做什么：检查 `main.ts`、`embedded.ts`、runtime/app 的调用链均使用新的迁移与查询；需要时更新有关注释/接线。维持宿主池所有权、`migrate: false` 和 `--no-migrate` 语义；不设置宿主 `search_path`，也不为了 schema 注入新建一个替代共享池。
- 预计修改：按实际需要修改 `apps/worker/src/main.ts`、`embedded.ts`、`app.ts`；检查 `runtime.ts`，没有相关变更则保留。
- 验收条件：daemon 与 embedded 都能使用新基线；stop 后注入池仍可使用；`prune --dry-run` 保持不执行迁移写入；不新增动态 schema 配置或破坏 public API。
- 前置依赖：本文件 T1。

## T3 · 更新 worker 相关测试

- 要做什么：更新匹配旧未限定 SQL 的 mocks，继续验证原有路由/统计/waiter/metrics 行为；补齐 shared pool 的接线断言。真实共库执行场景由 04 整合。
- 预计修改：`apps/worker/test/dashboard-*.test.ts`、`metrics.test.ts`、`metrics-wiring.test.ts`、`stats.test.ts`、`waiters.test.ts`、`embedded.test.ts`、`host.test.ts` 及实际受影响的相关测试。
- 验收条件：相关与完整 worker 单测通过；查询 mock 能识别限定表名，已有错误、timeout、取消、namespace 和注入池生命周期覆盖保持有效。
- 前置依赖：本文件 T1、T2。

## 验证方式

```bash
bun run build
bun run --cwd apps/worker typecheck
bun run --cwd apps/worker test
bun run --cwd apps/worker check:artifacts
git diff --check
```

在本 worktree 构建并检查当前产物，不复用其他 worktree 的 `dist`。本任务只对 worker 自身变更及测试负责；全仓库真实共库 acceptance 在 04 执行。

---

## 执行记录（opencode / alibaba-token-plan-cn/deepseek-v4.1-flash）

- T1：`routes/dashboard.ts`、`routes/metrics.ts`、`stats.ts`、`waiters.ts` 中全部真实 relation 引用改为静态限定名 `better_trigger.<table>`，与 kernel 任务 02 的写法一致（不引入 `DB_SCHEMA` 插值或字符串替换）。覆盖 dashboard 的 tasks 列表、runs keyset 分页、schedules 读（含 `LEFT JOIN better_trigger.runs`）、schedules PATCH 的 SELECT/UPDATE、workers 列表；stats 的三条 24h 聚合；metrics 的 queue gauge 与 `runs` 运行中子查询；waiters 的单次读取与 `id = ANY(...)` 批量 sweep。CTE 名（`jsonb_array_elements(namespaces) n`）、表别名、`EXCLUDED`、`$n` 参数绑定与 `project_id/env` namespace 过滤全部保留；`SELECT 1` 探针不涉及真实表。
- T2：核对 `main.ts`、`embedded.ts`、`app.ts`、`runtime.ts` 与迁移/查询入口——daemon 的 `migrate(pool)`、`createHealthPool` probe pool、embedded 的 `migrate as runMigrations`、`migrate: false` / `--no-migrate`、`prune --dry-run` 均直接复用 `packages/db` 的新基线入口，未设置 `search_path`、未包装 `pool.query()`、未为 schema 新建替代共享池、未新增动态 schema 配置或改动 public API，因此无代码接线变更。仅更新两处因基线重建而过时的注释/帮助文本：`main.ts` 的 `prune --dry-run` 注释（原文引用已删除的迁移 `0007` 孤儿清理）与 `cli.ts` 的 `PRUNE_USAGE --no-migrate` 说明（级联现来自初始基线的 run 外键），语义未变。
- T3：同步所有匹配旧未限定 SQL 的 mock，改为识别限定表名（regex 中转义为 `better_trigger\.`）：`audit.test.ts`（FROM schedules）、`http.test.ts`（FROM/UPDATE schedules）、`dashboard-tasks.test.ts`（FROM tasks）、`dashboard-runs-pagination.test.ts`（FROM runs）、`dashboard-runs-detail.test.ts`（kernel 的 runs/run_steps/waits/logs 及语句清单断言）、`metrics.test.ts`（FROM queue、FROM runs WHERE status='running'、probe pool 断言）、`waiters.test.ts`（FROM runs 计数）、`embedded.test.ts`（waiter 单次读取）。mock 只认限定名，未限定查询会落入默认空结果并让既有断言失败，不再被掩盖。新增 shared pool 接线断言：injected pool + 默认迁移时 `createPool` 不被调用、`migrate` 收到的就是宿主池对象；`stop()` 后不关闭宿主池且仍可查询。取消、timeout、单航班、namespace、注入池生命周期等既有覆盖全部保留。
- 真实 PostgreSQL 验证（本任务独占临时 cluster，PG 16.15，127.0.0.1 随机端口，trust，结束已 `pg_ctl stop` 并删除数据目录）：在 `/tmp/opencode` 与仓库内临时脚本（已删除、未提交）中执行——`migrate(pool)` 后 9 张业务表与 `__drizzle_migrations` 均在 `better_trigger`、`public` 无任何 relation；写入 acme/staging 与 other/prod 数据后，`computeTaskStats` 只统计目标 namespace（runs24h=3、successRate=50、lastRunAt 非空）、`collectMetrics` 的 queue_depth/inflight_runs gauge 数值正确；经 `createApp` + 真实池访问 GET /tasks、GET /runs、GET /schedules、PATCH /schedules/:id（回读 `better_trigger.schedules` 确认写入）、GET /workers 全部 200 且数据正确；waiter registry 的单次读取、批量 `ANY` sweep（等待中改状态后由 sweep 结清为 failed）与 not_found 均正常。独立 probe pool 由单测覆盖（`metrics.test.ts` 断言 gauge 查询走 probePool）。
- 校验结果：`bun run build` 通过（7/7 tasks）；`bun run --cwd apps/worker typecheck` 通过；`bun run --cwd apps/worker test` 49 文件 / 702 用例全部通过、0 skip；`bun run --cwd apps/worker check:artifacts` 通过（33 dist files / 36 packed files）；`bun run --cwd apps/worker lint` 通过；`git diff --check` 干净。构建产物中 dashboard/stats/waiters/metrics 的语句均为限定形式（dist 内无未限定表名）。
- 限制/风险：`packages/testing` 的 invariants/probe、examples/acceptance 与全仓库真实共库 acceptance 仍属任务 04，本中间状态未运行 `test:acceptance`；本任务未改 kernel/db/testing 源码、未升级依赖、未改无关文件。`prune --dry-run` 不迁移的语义经代码核对确认（`if (opts.migrate && !opts.dryRun) await migrate(pool)` 未变），无新增测试（真实 prune/DB 场景由 04 覆盖）。
