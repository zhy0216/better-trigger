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
