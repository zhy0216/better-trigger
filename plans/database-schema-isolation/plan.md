# better-trigger 专属 PostgreSQL schema

日期：2026-09-17。状态：方案已完成，待实施。

## 意图

让 better-trigger 可以与宿主项目共用 PostgreSQL 数据库，包括 embedded 模式直接复用宿主的 `pg.Pool`。当前项目没有显式指定业务表的 PostgreSQL schema：9 张表使用 `pgTable()`，默认落在 `public`；迁移记录使用 `drizzle.__drizzle_migrations`。这会与宿主的同名表或 Drizzle 迁移记录发生冲突。建议统一使用固定的 `better_trigger` schema，将业务表、自增序列和本项目的迁移记录放在其中，并让所有运行时 SQL 显式引用 schema。

**用户已确认：没有需要保留的 better-trigger 数据，可以从新 schema 建表。** 因此本方案采用重新生成初始迁移的方式，范围不包含旧 `public` 数据搬迁或旧版本数据库兼容。

## 仓库分析

| 位置 | 当前行为与影响 |
| --- | --- |
| `packages/db/src/schema.ts` | 9 张业务表均通过 `pgTable()` 定义；`queue`、`waits`、`logs` 使用 `bigserial`。`project_id/env` 是表内的数据分组，不能解决宿主表名冲突。 |
| `packages/db/drizzle.config.ts` | `schema: './src/schema.ts'` 指向模型文件，不是 PostgreSQL schema 名称；没有专属迁移记录配置。 |
| `packages/db/src/migrate.ts` | 只传入 `migrationsFolder`，依赖 Drizzle 默认的 `drizzle.__drizzle_migrations`；已用同一连接上的 advisory lock 串行化迁移，支持 `max: 1` 的注入池。 |
| `packages/db/migrations/` | 当前有 `0000` 至 `0016` 共 17 条迁移。建表和大部分 DML 未限定 schema，`0007`、`0011`、`0015` 的外键显式引用 `public`。在末尾追加搬表迁移仍会让新安装先操作宿主命名空间。 |
| `packages/kernel/src/` | `queue.ts`、`workers.ts`、`orchestrator.ts`、`prune.ts` 和 `runs-*` 模块使用原生 SQL。修改 Drizzle 模型不会自动改变这些查询。 |
| `apps/worker/src/` | `routes/dashboard.ts`、`routes/metrics.ts`、`stats.ts`、`waiters.ts` 直接访问未限定 schema 的表；metrics 还使用独立 probe pool。 |
| `apps/worker/src/embedded.ts`、`packages/db/src/pool.ts` | 支持直接传入宿主连接池，目前不设置 `search_path`；这一共享方式要求迁移和运行时查询都能在宿主连接配置下工作。 |
| 测试与验收 | `packages/kernel/test/pg/schema-drift.test.ts` 写死 `public`，约束测试匹配旧 SQL 文本；`migration.ts`、`constraints.ts`、`retention.ts` 还会重放旧迁移或修改旧 journal。 |
| `README.md`、`scripts/fixtures/git-consumer.ts` | README 明确说明当前使用 `public` 表和默认 journal；Git 安装验收仅有不同名的 `application_items`，尚未覆盖与宿主同名表共存。 |

已核对仓库使用的 Drizzle ORM 0.45.x 实现：运行时支持 `migrationsSchema`、`migrationsTable`，会先创建 journal schema/table，再按 journal 的最新 `created_at` 判断待执行迁移。因此共享 journal 不仅可能重名，还可能让另一项目的较新记录导致本项目迁移被跳过。

## 目标 / 非目标

目标：

- 新安装只在 `better_trigger` 内建立和访问本项目的持久化对象。
- 宿主可以在 `public` 或自己的 schema 中使用 `tasks`、`runs`、`queue` 等相同表名，也可以继续使用自己的 Drizzle journal。
- daemon、embedded、dashboard、metrics、prune、测试 harness 和 Git 源码安装入口使用一致的 schema。
- 宿主连接池的 `search_path` 与未限定表名的宿主查询保持原有行为。
- 保留当前任务执行、重试、租约、外键、索引和 `project_id/env` 的语义。

非目标：

- 旧 `public` 表的数据迁移、双写、兼容视图、跨此次 schema 切换的旧二进制回滚。
- 每个 `projectId/env` 创建独立 schema，或提供可配置的 schema 名称。
- 将手写 SQL 全部改为 ORM，或调整连接池、调度、通知协议和并发锁设计。
- 通过 schema 提供独立数据库的资源隔离，或建立新的租户权限体系。

## 方案

### 1. 固定 schema 和对象归属

采用 `better_trigger`，与数据库名称独立；用户可以继续连接名为任何名称的宿主数据库。

| 对象 | 新位置 |
| --- | --- |
| 业务表 | `better_trigger.tasks`、`better_trigger.runs`、`better_trigger.run_retry_operations`、`better_trigger.run_steps`、`better_trigger.queue`、`better_trigger.waits`、`better_trigger.logs`、`better_trigger.schedules`、`better_trigger.workers` |
| 表关联索引和自增序列 | 所属业务表所在的 `better_trigger` schema |
| 本项目迁移记录 | `better_trigger.__drizzle_migrations`，包括它自身的序列 |

在 db 包中定义 schema/journal 名称常量，供模型、迁移入口和 Drizzle Kit 配置复用。`schema.ts` 使用 `pgSchema('better_trigger').table(...)`，保留表内字段和约束设计。Drizzle 的 `pgSchema` 会让生成的表引用携带 schema，见 [Drizzle table schemas](https://orm.drizzle.team/docs/schemas)。

本期使用固定名字，手写 SQL 可直接写 `better_trigger.runs` 等静态限定名；不为拼接表名引入动态配置或新增 kernel 对 ORM 的运行时依赖。

### 2. 重新生成迁移基线，并隔离 journal

基于用户确认，全量重建 `packages/db/migrations/` 的当前迁移链：用现有最终模型生成一份带 schema 的初始 SQL、snapshot 和 `_journal.json`，替换现有 17 条迁移及对应元数据。历史版本仍可在 Git 历史中查阅，运行时只分发新的迁移链。

实施要点：

1. 从当前最终模型生成基线，保留所有字段默认值、复合主键、外键动作、CHECK、部分索引、列顺序和 NULL 排序，尤其是 `0016` 已补齐的索引。
2. 初始 SQL 中的所有表操作、外键目标和序列引用都属于 `better_trigger`；整个安装过程无须临时在 `public` 建表。
3. `migrate.ts` 显式传入 `migrationsSchema: 'better_trigger'` 和 `migrationsTable: '__drizzle_migrations'`；Drizzle Kit 配置同步设置 `migrations.schema/table`。可将 `schemaFilter` 限定为 `better_trigger` 以约束相关 Kit 操作，但它不能代替表模型及原生 SQL 的 schema 限定。Kit journal 配置依据见 [Drizzle migration configuration](https://orm.drizzle.team/docs/drizzle-config-file#migrations)。
4. 处理 schema 创建顺序：运行时 migrator 会先创建 journal 所在 schema，生成的初始 SQL 若含 `CREATE SCHEMA "better_trigger"`，应审阅并改为 `CREATE SCHEMA IF NOT EXISTS "better_trigger"`，避免首次安装重复创建失败。保留 snapshot 中的 schema 声明，并用真实 PostgreSQL 验收这一顺序。
5. 延续同一 pinned client 上的加锁、迁移、解锁流程；重复启动不重复建表或写入 journal，多进程首次启动应串行完成。
6. 新迁移入口只使用专属 journal。宿主的 `drizzle.__drizzle_migrations` 无须读取、复制、清理或重命名。
7. 目标 schema 内出现不兼容同名对象时给出明确错误；建业务表不能全部加 `IF NOT EXISTS` 来掩盖形状冲突。缺少 DDL 权限时报告具体失败，文档说明由迁移账号预先执行，再以 `migrate: false` / `--no-migrate` 启动。

`scripts/check-drift.mjs` 继续从 `./src/schema.ts` 对比 `./migrations` 的最新 snapshot；检查其 scratch-copy 行为及配置一致性判断仍适用于新基线。该检查不验证手工修改 SQL 的运行效果，因此不能替代真实数据库验收。

### 3. 显式限定所有 SQL 的真实表引用

按照查询实际引用的对象逐处调整，覆盖普通查询、事务、CTE 中的表访问、子查询、JOIN、写入、锁查询、prune 和统计聚合。

- kernel：`queue.ts`、`workers.ts`、`orchestrator.ts`、`prune.ts`、`runs-internal.ts`、`runs-create.ts`、`runs-read.ts`、`runs-steps.ts`、`runs-terminal.ts`、`runs-logs.ts`。
- worker：`routes/dashboard.ts`、`routes/metrics.ts`、`stats.ts`、`waiters.ts`。daemon 和 embedded 均通过现有迁移入口获得新表结构。
- 测试支持：`packages/testing/src/invariants.ts`、`probe.ts`；examples 中的直接 SQL；`scripts/fixtures/git-consumer.ts`。
- 验收辅助 SQL：`VACUUM/ANALYZE`、显式索引操作、catalog 查询和各测试的建数/清理语句。

只限定真实 relation 引用；保留 CTE 名称、表别名、`EXCLUDED` 和列引用的正确绑定，特别复核 `ON CONFLICT DO UPDATE` 的目标表引用。业务参数继续使用 `$1` 等绑定。

连接池不设置全局或 session 级 `search_path`，也不包装 `pool.query()` 做字符串替换。表的完整限定名可以直接选择所属 schema，而未限定名会按 `search_path` 解析，依据见 [PostgreSQL schema search path](https://www.postgresql.org/docs/16/ddl-schemas.html#DDL-SCHEMAS-PATH)。这样可让宿主与 better-trigger 交错使用同一池，并兼容 metrics 的独立连接池。

### 4. 更新现有测试并加入共库验收

测试调整需反映新的安装契约：

- db 的索引、外键和 retention 测试读取新基线，支持限定后的 SQL；保留最终约束行为的覆盖。旧迁移「先清理孤儿再加外键」的历史断言随旧迁移链退出，不改写为虚假的新基线需求。
- schema-drift 测试按 Drizzle 元数据中的 schema/name 查 catalog。业务表集合应排除 migrator 管理的 `__drizzle_migrations`，另行断言 journal 所属 schema；通过 catalog 的 schema/name 列比较，避免 `regclass::text` 的展示形式受 `search_path` 影响。
- 更新依赖 `FROM runs` 等文本的 SQL mock，使其继续验证原有行为，避免遗漏新查询后默默返回空结果。
- `examples/basic/scripts/migration.ts` 改为新基线的首次安装、重复安装、并发安装和 journal 隔离验收；同步更新 acceptance 入口中的说明。
- `constraints.ts`、`retention.ts` 去除对旧 migration 文件名、旧 journal 删除及旧升级清理的依赖，继续验证非法数据拒绝、CASCADE / SET NULL、取消/重试和 prune 行为。
- 在现有 embedded 和 Git consumer 场景加入宿主同名表；检查启动、任务执行与停止后宿主数据和连接池均正常。

关键验收矩阵见下方「校验」。各场景继续通过现有 `resetDb` 创建独占临时数据库，以该临时数据库模拟多项目共存。

### 5. 文档和交付入口

更新根 `README.md`、`apps/worker/README.md`、`docs/backend-contract.md` 及相关架构说明、中英文 embedded 文档、examples/testing README：写明固定 schema、迁移 journal 位置、共享 DB/pool 用法、自动迁移权限和此次新安装边界。移除「同名 public 表和全局 journal 必须未被使用」的旧说明。

检查 npm 的 `@better-trigger/db` 发布内容包含新 SQL 和元数据；验证 daemon、embedded 的构建产物以及根 package 的 Git 源码入口均能找到同一份迁移。`verify:git-install` 检查的是已提交 HEAD，实施验收要先确保提交包含本次改动，避免实际验证到旧代码。

## 拆解

以下仅为任务概览，不生成 `todos/`。

| 编号 | 任务 | 优先级 | 难度 | 依赖 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| 01 | db 专属 schema、journal 配置与新迁移基线 | P1 | hard | 无 | 9 张表与相关对象归属正确，首次/重复/并发 migrate 正常，新 snapshot 无漂移。 |
| 02 | kernel SQL 全部限定 schema，并调整相关单测 | P1 | hard | 01 | trigger、claim、重试、等待、cron、租约和 prune 在默认连接配置下正常。 |
| 03 | worker 查询、metrics、waiters 与 embedded 集成 | P1 | medium | 01、02 | 所有查询入口都访问目标 schema，共用池及独立 probe pool 均可工作。 |
| 04 | 测试 harness、旧基线断言适配和真实共库验收 | P1 | hard | 01、02、03 | 宿主同名表及其 journal 不受影响，schema-drift、约束和 acceptance 覆盖新契约。 |
| 05 | 文档、发布/Git 安装验证与全仓库校验 | P1 | medium | 01–04 | 文档与真实行为一致，打包迁移完整，所有适用检查通过。 |

建议按 `01 → 02 → 03 → 04 → 05` 集成；各代码任务同时更新其直接相关的测试，04 负责跨模块验收和历史测试清理。

## 执行偏好

- 默认 agent：`codex`，来源为当前 Codex 宿主。
- 用户未指定模型、推理强度或具体任务 agent。
- 后续拆队列时任务继承默认 agent，不将每个任务固化为某种执行器；需要执行时再按 Agent 分发规则解析难度对应设置。
- 本次只分析并产出本文件，不启动执行任务。

## 校验

本次是有明确需求的规划，已完成源码、配置和依赖实现检查；未运行构建、测试或数据库迁移。以下为实施后的验证要求。

| 场景 | 验收标准 |
| --- | --- |
| 空数据库首次安装 | 9 张业务表、它们的序列/索引以及 journal 均在 `better_trigger`；默认 `public` 下没有本项目新建的对象。 |
| 宿主同名表共存 | 预建宿主的 `tasks/runs/queue/logs` 等同名表和哨兵数据；安装、执行、dashboard、metrics、等待和 prune 后宿主结构及数据不变。 |
| 宿主 Drizzle journal 共存 | 预建 `drizzle.__drizzle_migrations`，包含时间戳晚于新基线的记录；better-trigger 仍完整建表，宿主 journal 内容不变。 |
| 注入共享池 | 使用 `max: 1`，以及宿主 schema 在前的 `search_path`；迁移和执行无死锁，宿主未限定表名的查询在启动前、运行中、停止后都返回宿主数据，`SHOW search_path` 不变。 |
| 独立 probe pool | daemon 的 metrics 通过单独连接访问正确表；不依赖业务池的 session 设置。 |
| 重复与并发迁移 | 重复调用为 no-op；两个独立池并发首次迁移都成功，journal 每个迁移仅一条，失败路径正确释放连接和锁。 |
| 最终数据库形状 | schema-drift 比较表、列、默认值和关键约束；外键均指向目标 schema，序列归属正确；保留已有索引形状及计划、约束和级联行为检查。 |
| 安装入口一致 | 构建后的 daemon/embedded 与 Git 源码安装在共库 fixture 上完成真实任务执行。 |

实施时的命令：

```bash
# 修改模型后，在 packages/db 内重新生成初始迁移及元数据
bun run --cwd packages/db db:generate

# 新基线及各模块完成后
bun run check:drift
bun run check:deps
bun run lint
bun run build
bun run typecheck
bun run test
bun run test:acceptance
bun run check:exports
bun run check:pkg-meta

# 已提交包含本次改动的 HEAD 后验证 Git 安装
bun run verify:git-install
```

`bun run test` 的真实 PostgreSQL 部分依赖 `DATABASE_URL`；不能把未配置数据库而跳过的结果算作数据库验收。`test:acceptance` 也需要可创建测试数据库的 PostgreSQL 连接。Git 安装的数据库执行检查需设置 `BT_GIT_TEST_ADMIN_URL`；仅完成无数据库的安装检查不足以证明共库可用。全部数据库检查使用测试环境。

## 风险与假设

- **已确认前提：无存量数据。** 新基线是新的数据库契约，不能作为原 `public` 部署的原地升级。如果实施前发现需要保留的旧部署，必须重新设计迁移路径，不能直接运行新基线替代它。
- **固定命名是本期默认选择。** 假设宿主将 `better_trigger` 留给本项目；如将来需要多个完全独立的 better-trigger 安装，需另行设计可配置 schema，以及相应 journal、通知和锁的作用域。
- **遗漏原生 SQL 是主要风险。** 空库测试可能让未限定的旧查询直接失败，也可能被测试中的 `search_path` 掩盖，因此共库测试保持宿主真实解析环境，并检查所有入口。
- **基线重建可能漏掉历史最终行为。** 以当前 `schema.ts`、最新 snapshot、已提交 SQL 和现有真实数据库行为测试共同校对，重点检查索引、外键、CHECK 和序列；不能只依赖离线 drift 检查。
- **新权限要求需写清楚。** 自动迁移账号需有创建目标 schema 和对象的权限；关闭自动迁移的运行账号需有对应 schema、表和序列的访问权限。schema 主要解决命名冲突，访问权限仍由数据库角色控制。
- 本方案没有需要用户继续决定的阻塞问题；schema 名称默认采用 `better_trigger`，无需新增运行时参数。

## 执行结果 · 2026-09-17

本轮 5/5 个 todo 已在独立 Herdr worktree 中完成、复核并串行快进合入 `main`。队列 README 声明本队列无独立并行任务（迁移、运行时 SQL 与验收共享同一数据库契约），因此按 `01 → 02 → 03 → 04 → 05` 单项滑动窗口执行，每个任务先 rebase 原分支再合入，任务代码最终提交为 `5e030ad5683da8afa102ef3adeb7cc39b44a427d`。全部 todo 原文及逐项验收记录已归档到 `todos/done/`。

用户 2026-09-17 启动时按难度覆盖了队列保存的单一模型默认值：hard 用 `alibaba-token-plan-cn/qwen3.8-max`（01、02、04），medium 用 `alibaba-token-plan-cn/deepseek-v4.1-flash`（03、05）；agent 类型全部为 OpenCode，均以 `--auto` 启动，没有重启、换 agent 或降档。

| todo / 归档 | 合入 commit | 实际 agent / 模型 | 协调器复核 gate（真实 PG，无 skip） |
| --- | --- | --- | --- |
| [01-db-schema-and-baseline.md](todos/done/01-db-schema-and-baseline.md) | `9f75dc74f3c8be3d462084a00411be4b053e9ccc` | opencode / qwen3.8-max | `packages/db test` 83/83、typecheck、`check:drift`、`check:deps`；另以 psql 独立复核 9 表 + journal + 4 序列全在 `better_trigger`、`public` 空、无 `drizzle` schema、重复 migrate no-op |
| [02-kernel-qualified-sql.md](todos/done/02-kernel-qualified-sql.md) | `1490c8ac9fda196069c7a7bf7ca3d7f7e5346098` | opencode / qwen3.8-max | kernel+testing build、kernel typecheck、`packages/kernel test` 60 文件 / 484 用例（0 skip）、`check:deps` |
| [03-worker-schema-integration.md](todos/done/03-worker-schema-integration.md) | `74e738b8d0ceb6e92b06d41a75a5bdcb86dad5b5` | opencode / deepseek-v4.1-flash | `bun run build` 7/7（worker 非缓存重建）、worker typecheck、`apps/worker test` 49 文件 / 702 用例、`check:artifacts` 33 dist / 36 packed |
| [04-shared-database-acceptance.md](todos/done/04-shared-database-acceptance.md) | `c8a07cde2a21456df756920a550127bdae6a893c` | opencode / qwen3.8-max | testing test 104/104（真实 PG）、testing/examples typecheck、`check:drift`、acceptance 8 场景（migration embedded constraints retention health-pool stats notify schema-isolation）全通过，新增 schema-isolation 7 checks |
| [05-docs-and-delivery-verification.md](todos/done/05-docs-and-delivery-verification.md) | `5e030ad5683da8afa102ef3adeb7cc39b44a427d` | opencode / deepseek-v4.1-flash | `check:drift`、`check:deps`、`check:pkg-meta` 40/40、`check:exports`、lint 9/9、build 7/7、typecheck 14/14、`test -- --force` 13/13（1,933 用例，kernel 484 真实 PG）、`test:acceptance` 20/20 harness、`verify:git-install` exit 0（对已提交 HEAD `5e030ad`，真库完成共库同名表 / 共享 `max:1` 池 / 迁移与执行）、`git diff --check` |

每个任务在集成前由原 agent 亲自 rebase 到当时 `main`（本轮主线仅由本队列推进，五次 rebase 均为 up-to-date、零冲突、无额外 amend 需求；05 的唯一 amend 只追加归档记录，被验证源码提交 `43bf390` 与最终 `5e030ad` 的源码/文档树一致）。复核未通过项为零；没有任务需要恢复操作。

### 结果与验收

- 新安装契约已落地：9 张业务表、索引、序列与 `better_trigger.__drizzle_migrations` 全部属于固定 schema `better_trigger`；`public` 与本项目无关，宿主 `drizzle.__drizzle_migrations` 不被读取或改写（宿主 journal 含更晚时间戳的哨兵记录也不会跳过本项目基线）。
- 迁移账号 DDL 权限、`--no-migrate` / `migrate: false`、无存量数据的新安装边界、不可配置 schema、schema 不带来权限/资源隔离均已写入 README、worker README、backend-contract、architecture 与中英文 embedded 文档，并与 `packages/db/src/constants.ts`、`migrate.ts` 实现一致。
- Git 源码安装与发布产物都读取同一份新迁移；`verify:git-install` 在真实数据库上完成共库与共享池验证。
- 无 blocked、deferred 或未完成队列项。

### 保留的既有问题（本轮未改）

- `BT_STATS_ROWS` 缩小规模（如 200000）时 `bench:stats` 的若干计划断言失败（规划器改选位图扫描），属规模相关期望问题，默认规模通过。
- tsdown 构建的 TS2688 'node' 噪音为既有问题，构建 exit 0。
- `bun run test -- --force` 下 packages/sdk 的自身重建 clean 窗口偶发竞态（本轮仅 05 记录到一次，随后 canonical `bun run test` 与协调器的 `--force` 全量重跑均全绿，未复现），与本次改动无关。

### 归档、范围与清理

本轮 5 个 Herdr agent 均正常退出，对应 workspace、worktree 和任务分支已删除；协调器自建临时 PostgreSQL 实例已停止并清理。没有 push、创建 PR 或修改远端。仓库中仍存在的 `scheduled/database-schema-isolation-20260917*` worktree 与分支来自上一轮无关执行，来源不明，本轮未触碰、未清理。原 checkout 保持 `main`，本节及队列 README 状态以单独的收尾文档 commit 提交，提交后 `git status --short` 为空。
