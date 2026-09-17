difficulty: hard
agent: inherit

# 04 · 测试支持适配与真实共库验收

优先级：P1。依赖 01、02、03 全部完成。独立 worktree，一个最终 commit。

## T1 · 调整 testing harness 和全部 examples SQL

- 要做什么：限定 invariant/probe、examples 场景及 benchmark 中直接访问业务表的 SQL；包含建数、清理、索引和 ANALYZE 等辅助操作。保留测试数据库的唯一命名及所有权清理规则；不向 pool 注入 search_path 来让旧语句暂时可用。
- 预计修改：`packages/testing/src/invariants.ts`、`probe.ts`、相关 `packages/testing/test/`；`examples/basic/scripts/*.ts` 中实际访问数据库的场景和 benchmark。
- 验收条件：testing 单测及数据库 helper 测试通过；场景独立建库/清理，不影响已有数据库；库内业务断言确实读取 `better_trigger`，未出现未限定业务表的运行语句。
- 前置依赖：01、02、03。

## T2 · 替换旧迁移历史验收

- 要做什么：将 migration 场景改为新基线首次、重复和两池并发安装；在宿主默认 Drizzle journal 插入时间戳晚于本项目新基线的哨兵记录，再确认本项目仍正常安装。更新 constraints/retention，去除 0007/0011 等历史重放及删除旧 journal 的逻辑。
- 预计修改：`examples/basic/scripts/migration.ts`、`constraints.ts`、`retention.ts`、`acceptance.ts`。
- 验收条件：宿主 journal 的结构和内容不变；专属 journal 每个迁移仅一条；新基线完整创建对象。保留真正的 FK/CHECK 拒绝、CASCADE/SET NULL、取消/重试和 prune 回归；旧历史清理测试不再被宣传为新安装的行为。
- 前置依赖：本文件 T1。

## T3 · 验证同名表、共享连接池和所有运行入口

- 要做什么：在独占测试数据库中创建宿主 `public` 或 `host_app` schema 的同名表和哨兵数据，与 better-trigger 共存。通过 daemon 和 embedded 实际执行任务，验证 dashboard、stats、metrics、waiter、prune；运行前后比较宿主结构/数据以及 `SHOW search_path`。补充 `max: 1` 共享池、宿主 schema 优先的 search_path 和独立 probe pool 场景。
- 预计修改：`examples/basic/scripts/embedded.ts`、`health-pool.ts`、必要的 `stats.ts`、`retention.ts` 或 `migration.ts`；若场景独立更清晰，可新增 `schema-isolation.ts` 并注册至 `acceptance.ts`（新增场景必须进入统一入口）。修改 `scripts/fixtures/git-consumer.ts`，使安装验收也覆盖同名宿主表与共享池。
- 验收条件：宿主未限定表名的查询在启动前、运行中、停止后均命中宿主表；宿主数据不变；本项目的行只进入目标 schema。注入池可在 stop 后继续使用，首次迁移与任务执行在单连接池上无死锁；metrics 不依赖业务池 session。Git consumer 的本次源码 fixture 就绪，实际 pinned HEAD 安装在 05 验证。
- 前置依赖：本文件 T1、T2。

## 验证方式

```bash
bun run build
bun run --cwd packages/testing test
bun run --cwd packages/testing typecheck
bun run --cwd examples/basic typecheck
bun run check:drift
git diff --check
```

在 `examples/basic` 目录执行 `bun scripts/acceptance.ts migration embedded constraints retention health-pool stats notify`；若新增 `schema-isolation`，将它加入本次选择并确认统一入口确实注册。真实 PostgreSQL 必须是本任务创建的测试实例，记录具体通过的场景和失败原因。此处运行共库/迁移相关场景，05 再执行最终完整验收。
