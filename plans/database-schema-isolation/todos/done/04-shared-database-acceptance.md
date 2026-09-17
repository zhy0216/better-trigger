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

---

## 执行记录（opencode / alibaba-token-plan-cn/qwen3.8-max）

- T1：`packages/testing/src/invariants.ts`（runs/run_steps/queue/waits 读取）与 `probe.ts`（tasks/queue）全部改为静态限定名 `better_trigger.<table>`；`invariants.test.ts` 的 mock 只认 `FROM better_trigger.*`，未限定 SQL 会落入 `unexpected SQL` 显式失败，不被掩盖。examples 的 16 个场景/基准脚本逐条限定建数、清理、计数、EXPLAIN、`LOCK TABLE better_trigger.queue`、逐表限定的 `VACUUM/ANALYZE` 列表、`DROP INDEX better_trigger.*`，claim-scan-bench 的 `pg_indexes` 读取增加 `schemaname = 'better_trigger'` 过滤；stats-bench/claim-scan-bench 中镜像 kernel/worker 的 SQL 副本与已合入的限定版本一致。resetDb 的唯一命名、所有权清理与 envVar 覆盖规则未动；没有向任何业务/场景 pool 注入 search_path——新增隔离场景中的 host-mode 连接串 `options=-csearch_path=host_app,public` 是"宿主自己的选择"，属于被测契约本身。
- T2：`migration.ts` 重写为新基线安装验收：宿主 `drizzle.__drizzle_migrations` 预置 created_at 晚于基线（when+1d）的哨兵行后 `migrate()` 仍完整建对象，宿主 journal 结构与内容逐字节不变；专属 journal 每个 `_journal.json` 条目恰一行（sha256 hash 与 folderMillis 均核对）；9 表 + journal + bigserial 序列归属 `better_trigger`，`public` 无任何 relation；重复 migrate 为 no-op；第二个独占库上两个 `max: 1` 池并发首次安装均成功且 journal 恰 1 行。`constraints.ts` 删除 0011 孤儿清理历史重放（原第 6 节，含约束/索引重建与 journal 删除），保留基线约束清单、CASCADE/SET NULL、ChildLost 恢复、schedule 级联、14 项非法写入拒绝（23514/23503）、prune CLI 与 cancel/retry 无孤儿回归；`retention.ts` 同样删除孤儿/journal 重放节，保留级联与 prune CLI 检查；两文件的 0007/0011/0016 历史叙述与未用 import 一并清除。`acceptance.ts` 的 migration/embedded/health-pool 描述同步更新，不再宣传旧历史清理为新安装行为。
- T3：新增 `schema-isolation.ts` 并注册进 `acceptance.ts`（紧随 embedded）：宿主 `public` 九张同名表 + `host_app.tasks` 影子 + 哨兵行 + 含更晚时间戳哨兵的宿主 journal；daemon 以连接串 `options=-csearch_path=host_app,public` 启动并自行首次安装（migrate: true）；宿主结构（information_schema + pg_class relation 清单）与数据（全部行 + journal）在运行前后逐字节比对，`SHOW search_path` 恒定；未限定宿主读写在启动前、运行中、停止后均命中宿主表；真实执行 hello-world / order-pipeline 并经 waiter（waitForResult）结清；dashboard /tasks（runs24h 统计、无宿主行泄漏）、/workers、/schedules、/metrics（db_up 1 + queue_depth/inflight gauge，独立 probe pool）全部正确；prune CLI 删除 better_trigger 历史而宿主行不动；public 恰好只有宿主 9 表。`embedded.ts` 改为注入宿主自有池：`max: 1` + host-first search_path，首次迁移与全部任务执行在单连接上无死锁，stop 后注入池仍可用、search_path 不变、better-trigger 行只在 better_trigger，宿主快照不变。`health-pool.ts`：daemon 业务池与 probe pool 均按 host-first 连接串接入，宿主 `public.queue`(7 行)/`public.runs` 哨兵共存时 gauge 报 `better_trigger.queue` 的 3 行而非宿主计数；新增 check e 验证未限定宿主查询仍命中宿主表。`scripts/fixtures/git-consumer.ts`：宿主 5 张同名表 + host_app.tasks 影子 + 哨兵行，共享池改为 `max: 1` 且 host-first search_path；断言运行前后未限定解析、宿主哨兵不变、better_trigger.runs=2；以 verify-git-install 的严格 tsconfig（noUncheckedIndexedAccess 等）本地 typecheck 通过，pinned HEAD 实装验证按计划留在 05。
- 真实 PostgreSQL 验证（本任务独占临时 cluster：PG 16.15，127.0.0.1:49463，trust，结束已 pg_ctl stop 并删除数据目录）：
  - `packages/testing test`（带 DATABASE_URL）：6 文件 / 104 用例全部通过（database.pg.test.ts 真实执行，无 skip）。
  - 任务要求的 acceptance 选择 `migration embedded constraints retention health-pool stats notify` + 新增 `schema-isolation`：8/8 通过（migration 4 checks、embedded 6、constraints 8、retention 4、health-pool 5、stats 4、notify 10、schema-isolation 7）。
  - 完整 acceptance 套件：20/20 harness 全部通过（161.5s），无失败场景。
  - 全仓库 `bun run test`（带 DATABASE_URL）：13/13 任务通过——kernel 60 文件、worker 49、db 6、testing 6、core 6、web 24、根/sdk 9，PG 门控用例真实执行。
  - 基准：`bench:claim-scan` 9/9 通过（含 pg_indexes/DROP INDEX/indexdef 重建限定路径）；`bench:stats` 默认 1M 行 3/3 通过。
  - git-consumer fixture 以工作树源码 file: 安装 + `BT_GIT_TEST_ADMIN_URL` 真实库执行通过（含 max:1 共享池、同名宿主表、二次启动）。
- 校验结果：`bun run build` 7/7 通过；`packages/testing test/typecheck/lint`、`examples/basic typecheck/lint` 通过；`check:drift`、`check:deps` 通过；`git diff --check` 干净。
- 限制/风险：
  - `bench:stats` 在 `BT_STATS_ROWS=200000` 缩小规模下 2 项计划断言失败（drop runs_created_idx 后规划器改选 runs_task_created_idx 位图扫描而非 Seq Scan）——该期望依赖数据规模的既有问题，与本次 schema 限定无关（默认 1M 行通过）；未顺手改 bench 断言。
  - tsdown 构建打印既有非致命噪音 `TS2688 Cannot find type definition file for 'node'`（在未改动的 kernel 包 --force 构建同样复现），turbo 任务全部 exit 0。
  - `verify:git-install`（pinned HEAD）与 README/docs 更新按计划属于 05；examples/basic/README.md 未列入本任务修改范围。
