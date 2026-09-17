difficulty: hard
agent: inherit

# 02 · kernel 原生 SQL 显式指定 schema

优先级：P1。依赖 [01-db-schema-and-baseline.md](01-db-schema-and-baseline.md)。独立 worktree，一个最终 commit。

## T1 · 调整运行、步骤和日志读写

- 要做什么：逐条检查 run 创建、读取、终态转换、重试、step、日志和内部事务的真实 relation 引用，改用 `better_trigger.<table>`。同时检查 CTE、子查询、`RETURNING` 和 `ON CONFLICT DO UPDATE` 的绑定；保留别名、CTE 名和 `EXCLUDED`，业务值继续参数绑定。
- 预计修改：`packages/kernel/src/runs-create.ts`、`runs-read.ts`、`runs-steps.ts`、`runs-terminal.ts`、`runs-logs.ts`、`runs-internal.ts`；检查 `runs.ts` 导出入口，仅在确需时修改。
- 验收条件：幂等触发、retry operation key、step replay、父子等待、取消和日志边界维持原语义；所有真实表引用均限定 schema；没有查询文本全局替换包装或 `search_path` 依赖。
- 前置依赖：01 全部完成。

## T2 · 调整调度、worker、队列与清理

- 要做什么：限定注册、claim、heartbeat、release、cron、timer、reaper、worker 离线与 prune 使用的表。保留事务边界、锁次序、`FOR UPDATE SKIP LOCKED`、fencing token、namespace pair 过滤、数据库时钟及通知行为。
- 预计修改：`packages/kernel/src/queue.ts`、`workers.ts`、`orchestrator.ts`、`prune.ts`。
- 验收条件：正常 claim/释放与后台循环访问新表；内部引用和 `ON CONFLICT` 条件仍正确；原先的调度公平性、并发限流和级联删除测试保持有意义。
- 前置依赖：01 全部完成；本文件 T1。

## T3 · 更新 kernel 测试和 catalog 探针

- 要做什么：同步调整 `packages/kernel/test/` 中匹配 SQL 的 stub；适配 `test/pg/` 建数、清理、EXPLAIN、VACUUM/ANALYZE 及查询。`schema-drift.test.ts` 根据模型 schema/name 读取 catalog，单独处理 journal，并避免依赖 `regclass::text` 的显示格式。
- 预计修改：`packages/kernel/test/**/*.test.ts`、必要的 PG helper；重点包括 `test/pg/schema-drift.test.ts`、`plans.test.ts`、`smoke.test.ts`、`fencing.test.ts`、`retry-idempotency.test.ts`、`wait-graph.test.ts`、`claim-namespace-fairness.test.ts`。只改与新 schema 相关的 fixtures/断言，不扩大引擎语义。
- 验收条件：kernel 单测通过；真实 PG suite 在正常 search_path 下访问目标表，journal 不计入 9 张业务表；检查最终列、默认值、约束、序列与索引；至少运行代表性的 trigger/claim、fencing、retry、wait/cron 回归。未知 SQL 不得通过 stub 默认空结果掩盖。
- 前置依赖：本文件 T1、T2。

## 验证方式

```bash
bun run build -- --filter=@better-trigger/kernel --filter=@better-trigger/testing
bun run --cwd packages/kernel typecheck
bun run --cwd packages/kernel test
bun run check:deps
git diff --check
```

`DATABASE_URL` 指向本任务独占 PostgreSQL，确保真实 PG 测试执行而非 skip。若某个用例确实依赖尚待 04 调整的 testing harness，记录具体依赖和失败，不在本任务越界修改整个 examples；kernel 自己的查询与 fixture 适配应完成。本任务不修改 worker 源码或 testing 包源码。

---

## 执行记录（opencode / alibaba-token-plan-cn/qwen3.8-max）

- T1：`runs-create.ts`、`runs-read.ts`、`runs-steps.ts`、`runs-terminal.ts`、`runs-logs.ts`、`runs-internal.ts` 中全部真实 relation 引用改为静态限定名 `better_trigger.<table>`（含 CTE 内表访问、子查询、`RETURNING`、`FOR UPDATE` 锁查询）。CTE 名（`doomed`/`serving`）、表别名（`q/r/t/w/c/s`）与 `EXCLUDED` 绑定原样保留，业务值仍走 `$n` 参数。`ON CONFLICT DO UPDATE` 目标表以隐式别名引用（`tasks.latest_code_version`、`run_steps.status`、`schedules.cron_pattern`）在限定 INSERT 下仍正确解析——由真实 PG 的 registration-guard、replay-canonicalization、idempotency、retry-idempotency 用例验证。`runs.ts` 仅是 barrel，未改。`run_retry_operations` PK 的 63 字节截断名复核未变，`RETRY_OPERATION_UNIQUE_CONSTRAINT` 无需调整（drift 测试断言其与 live catalog 一致）。
- T2：`queue.ts`、`workers.ts`、`orchestrator.ts`、`prune.ts` 全部限定；注册 upsert、claim 候选扫描、并发限流 advisory lock、fencing token bump、heartbeat/release、cron 扫描与 fire、reaper、offline marker、stranded scan、prune 候选/删除语句均访问新表。事务边界、锁次序（queue→runs→dependent）、`FOR UPDATE SKIP LOCKED`、namespace pair 过滤、`($n::text || ' milliseconds')::interval` 数据库时钟绑定与 pg_notify 行为未动。未引入查询文本替换包装或任何 `search_path` 设置。
- T3：36 个单测文件的 stub 匹配正则同步限定（regex 中点号转义为 `better_trigger\.`，字符串/`includes`/LIKE 形式用原样点号），未知 SQL 仍落入各 stub 的显式断言路径而非静默通过；`test/pg/` 建数、清理、`EXPLAIN`、`pg_stat_activity` LIKE 探针全部限定，`VACUUM/ANALYZE` 列表逐表限定，`LOCK TABLE better_trigger.runs`。`schema-drift.test.ts` 重写：schema/表名取自 Drizzle 模型元数据（`getTableConfig().schema` 与 `DB_SCHEMA` 双向断言），catalog 经 `pg_class/pg_namespace/pg_indexes` 的 schema/name 列读取，不再用 `conrelid::regclass::text`；journal（`MIGRATIONS_TABLE`）单独断言存在且不计入 9 张业务表；在原有列/可空性/CHECK/PK 之上新增列默认值（nextval 显示形式与 jsonb 键序归一后比较）、序列清单与归属（`pg_get_serial_sequence`）、非约束二级索引集合、FK 引用表全部位于目标 schema 的比较。
- 真实 PostgreSQL 验证：本任务独占临时 cluster（PG 16.15，127.0.0.1 随机端口，trust，`search_path = "$user", public`，结束已销毁）。`DATABASE_URL` 指向该 cluster 后 `bun run --cwd packages/kernel test`：60 文件 / 484 用例全部通过、0 skip（25 个 pg 文件真实执行）。代表性回归另单独复跑通过：smoke（trigger/claim）、fencing、retry-idempotency、wait-graph、trigger-and-wait、claim-namespace-fairness、cron-unserved、cron-skew、schema-drift、plans（EXPLAIN 索引计划）共 40 用例。
- 校验结果：`bun run build -- --filter=@better-trigger/kernel --filter=@better-trigger/testing` 通过；`packages/kernel typecheck` 通过；`packages/kernel test` 通过（无 DATABASE_URL 时 372 passed + 112 skipped，带 DATABASE_URL 484 passed）；`bun run check:deps` 通过；`git diff --check` 干净。
- 限制/风险：`apps/worker`（任务 03）、`packages/testing` 的 invariants/probe 与 examples/acceptance（任务 04）仍使用未限定表名，本中间状态下全仓库 PG 套件与 `test:acceptance` 不适用、未运行；kernel 自身的 pg 测试仅依赖 testing 的 `resetDb`（建库 + 新基线迁移），未依赖待 04 调整的部分，无越界修改。
