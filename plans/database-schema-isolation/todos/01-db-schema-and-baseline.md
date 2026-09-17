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
