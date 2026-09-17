difficulty: hard
agent: inherit

# 01 · 专属 schema、迁移 journal 与新基线

优先级：P1。按队列 README 解析执行器和模型。独立 worktree，完成后一个最终 commit。

## T1 · 声明固定 schema 并保留最终模型

- 要做什么：在 db 包内定义固定的 `better_trigger` schema/journal 名称常量；将 9 张业务表从 `pgTable()` 改为 `pgSchema(...).table()`。保留字段类型、默认值、复合主键、FK 动作、CHECK、索引和 NULL 排序；schema 名称与数据库名独立。
- 预计修改：`packages/db/src/schema.ts`、`packages/db/src/index.ts`；可新增只含名称常量的 `packages/db/src/constants.ts`（新增文件，按需要导出）。
- 验收条件：模型中 9 张表均声明目标 schema；`queue/waits/logs` 的自增定义完整；索引和约束与当前最终模型等价；不新增 kernel 对 ORM 的运行时依赖。
- 前置依赖：无。

## T2 · 生成新的迁移链并隔离 journal

- 要做什么：基于 T1 重新生成 `packages/db/migrations/` 的单份初始迁移、snapshot 和 `_journal.json`，替换旧 0000–0016 历史。全部表、FK、索引、序列在目标 schema 创建。`migrate()` 显式设置 `migrationsSchema/migrationsTable`，Kit 同步配置 `migrations.schema/table`。
- 预计修改：`packages/db/src/migrate.ts`、`packages/db/drizzle.config.ts`、`packages/db/migrations/**`；仅确有必要时修改 `scripts/check-drift.mjs`。
- 验收条件：journal 位于 `better_trigger.__drizzle_migrations`；首次安装无 `public` 中间建表；没有读取或重写宿主的 `drizzle.__drizzle_migrations`。注意 migrator 会先创建 journal schema，初始 SQL 的 `CREATE SCHEMA` 应使用 `IF NOT EXISTS` 避免重复创建。保留同一 pinned client 上的迁移锁和 `max: 1` 支持；不以所有建表均 `IF NOT EXISTS` 掩盖对象形状冲突。
- 前置依赖：本文件 T1。

## T3 · 更新 db 测试并验证新基线

- 要做什么：调整 SQL 形状断言，支持带 schema 的新基线；移除仅对旧升级清理有效的历史断言，保留最终 FK/CHECK/索引/级联要求。迁移 mock 校验专属 journal 参数以及同一连接加锁、解锁和错误释放。用独占 PostgreSQL 验证首次、重复及两池并发 migrate。
- 预计修改：`packages/db/test/migrate.test.ts`、`schema-constraints.test.ts`、`schema-indexes.test.ts`、`schema-retention.test.ts`；必要时新增 `packages/db/test/migrate-schema.pg.test.ts`（新测试文件，门控方式与现有 DB 测试一致）。
- 验收条件：db 单测与 drift 检查通过；真实数据库有 9 张业务表和单独断言的 journal，自增序列归属正确；并发迁移无重建/重复 journal/死锁；不依赖被本任务改变的 kernel 查询来测试迁移。
- 前置依赖：本文件 T1、T2。

## 验证方式

```bash
bun run --cwd packages/db db:generate
bun run --cwd packages/db test
bun run --cwd packages/db typecheck
bun run check:drift
bun run check:deps
git diff --check
```

生成命令应在清理并重新建立基线的流程中使用，不能简单向旧历史追加搬表迁移。PG 验证使用自己创建的临时数据库，记录实际执行结果；T3 新增真实数据库测试时显式提供测试 `DATABASE_URL`。完整 acceptance 在后续任务完成适配后执行。

---

## 执行记录（opencode / alibaba-token-plan-cn/qwen3.8-max）

- T1：新增 `packages/db/src/constants.ts`（`DB_SCHEMA='better_trigger'`、`MIGRATIONS_TABLE='__drizzle_migrations'`，经 index.ts 导出）；schema.ts 9 张表改为 `pgSchema(DB_SCHEMA).table()`。新 snapshot 与旧 `0016_snapshot.json` 逐项脚本比对：columns/indexes/FK/CHECK 完全一致，唯一差异是 partial index 谓词的 schema 限定（预期变化）。db 包依赖未变，未新增 kernel 对 ORM 的运行时依赖。
- T2：删除旧 0000–0016，`db:generate --name initial_schema` 重生成单份 `0000_initial_schema.sql` + snapshot + `_journal.json`。migrate.ts 显式传 `migrationsSchema/migrationsTable`（pinned-client advisory lock 与 `max: 1` 逻辑未动）；drizzle.config.ts 设 `migrations.schema/table`。drizzle-kit 0.31 未生成 `CREATE SCHEMA`，为使基线自包含在文件头补 `CREATE SCHEMA IF NOT EXISTS "better_trigger"`（运行时 migrator 先行创建 journal schema，IF NOT EXISTS 避免冲突）；业务表未用 IF NOT EXISTS，同名异形对象仍会显式失败。check-drift.mjs 未改。
- T3：migrate.test.ts 新增 journal 参数断言（硬编码契约字符串）；schema-constraints/indexes/retention 三个测试改为限定名断言，移除仅对旧升级链有效的孤儿清理顺序断言；新增 `migrate-schema.pg.test.ts`（DATABASE_URL 门控，与 pool.test.ts 一致；自建/自清临时库，仅用 pg + src/migrate，不依赖 kernel）。
- 真实 PostgreSQL 验证：临时独占 cluster（PG 16.15，127.0.0.1:58455，trust，已销毁）。`bun run --cwd packages/db test` 带 DATABASE_URL 83/83 通过，覆盖：首次安装（9 表 + journal + 4 序列全在 better_trigger，public 空，预置的宿主 `drizzle.__drizzle_migrations` 含未来时间戳仍原样保留且未跳过基线）、重复 migrate 为 no-op、两个 max:1 池并发首次迁移均成功且 journal 恰 1 行。另有 psql 级人工复核（schemas/tables/sequences/journal 输出同上）。
- 校验结果：`db:generate` no-op（"No schema changes"）；`packages/db test`（无 DATABASE_URL 78 passed + 5 skipped；有则 83 passed）；`typecheck` 通过；`check:drift` 通过；`check:deps` 通过；`packages/db lint` 通过；`git diff --check` 干净。
- 限制/风险：kernel、worker、testing、examples 仍引用未限定表名与旧 journal（任务 02–05 范围），本中间状态下全仓库 PG 套件与 acceptance 不适用、未运行。
