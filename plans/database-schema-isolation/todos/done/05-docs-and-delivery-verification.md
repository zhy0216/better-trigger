difficulty: medium
agent: inherit

# 05 · 文档、发布产物和最终验证

优先级：P1。依赖 01–04 全部完成。独立 worktree，一个最终 commit。

## T1 · 更新用户文档和数据库契约

- 要做什么：说明固定 `better_trigger` schema、专属 journal、与任意宿主数据库共用的方式，以及 embedded 注入池行为。说明迁移账号的 DDL 权限和关闭自动迁移的用法，写清此次为无存量数据的新安装契约。同步验收场景说明，删除对旧 public 表/全局 journal 必须空闲及旧历史迁移验收的陈述。
- 预计修改：`README.md`、`apps/worker/README.md`、`docs/backend-contract.md`、相关 `docs/architecture.md`、`apps/docs/guide/embedded-mode.md`、`apps/docs/zh/guide/embedded-mode.md`、`examples/basic/README.md`、`packages/testing/README.md`；搜索到的直接相关中英文说明一并核对。
- 验收条件：文档中的对象名与实现一致，数据库名没有被误写成必须为 `better_trigger`；没有承诺旧库原地升级、可配置 schema 或 schema 带来独立资源/权限隔离。
- 前置依赖：01–04。

## T2 · 检查打包与源码安装入口

- 要做什么：核对 db 包 `files` 中实际打包的新 SQL/snapshot/journal，daemon 和 embedded 构建后能解析迁移目录；验证 Git 源码依赖也读取相同迁移。只在发现实际打包缺口时调整现有构建/检查脚本。
- 预计修改：按需修改 `packages/db/package.json`、`packages/db/tsdown.config.ts`、`apps/worker/tsdown.config.ts`、`scripts/check-package-meta.mjs`、`scripts/verify-git-install.ts`；04 已调整的 Git consumer fixture 除发现缺陷外不重复改造。
- 验收条件：`check:exports`、`check:pkg-meta` 和 Git 安装验证通过；源码与发布产物均完成数据库执行。`verify:git-install` 必须针对包含 01–05 改动的已提交 HEAD，设置 `BT_GIT_TEST_ADMIN_URL` 启用实际数据库检查。
- 前置依赖：本文件 T1；04 的 Git consumer fixture 已提交。

## T3 · 完整验收并交付集成分支

- 要做什么：运行全仓库 gate 与真实 PG、完整 acceptance，修复本队列引入的集成缺陷，记录命令/结果及源码提交。核对 9 张业务表、相关序列/索引和 journal 的归属，确认共库矩阵全部覆盖。将自己的完成记录归档并更新队列状态；与启动时记录的主分支安全集成。
- 预计修改：本 todo 完成记录及 `todos/README.md`；仅当发现本次改造造成的缺陷时修复相应源码/测试/文档。
- 验收条件：下列适用检查全部通过，PG suites 没有因缺 URL 被跳过；所有任务有独立最终 commit，工作区干净。主分支若有并发改动，先在隔离分支处理再验证；不覆盖用户改动、不推送远端。不能把 OpenCode 正常退出当成测试通过或任务完成。
- 前置依赖：本文件 T1、T2。

## 验证方式

```bash
bun run check:drift
bun run check:deps
bun run lint
bun run build
bun run typecheck
bun run test
bun run test:acceptance
bun run check:exports
bun run check:pkg-meta
bun run verify:git-install
git diff --check
```

用独占 PostgreSQL 设置 `DATABASE_URL`，同时以该测试实例的管理连接设置 `BT_GIT_TEST_ADMIN_URL`。缓存不应让真实 PG 测试被旧结果替代；必要时对 test 使用 Turbo `--force`，记录实际执行数。

Git 安装的验证顺序：先提交本任务待验证的源码/文档，再运行 `verify:git-install`；若修复后重做提交，应重新验证实际变更的源码。可 amend 补充纯结果记录，最终仍为一个任务 commit，并注明真正被测的源码提交。已通过的检查只在新改动、失败或未解决问题需要时重跑。

---

## 执行记录（opencode / alibaba-token-plan-cn/deepseek-v4.1-flash）

- T1 · 文档与数据库契约（19 个文件，全部为文档）：
  - 根 `README.md`：新增「Sharing a Postgres database」小节——固定 `better_trigger` schema 与数据库名无关、9 张业务表/索引/序列与专属 `better_trigger.__drizzle_migrations`、宿主 `public` 表和 `drizzle.__drizzle_migrations` 永不被读写、连接池不设置 `search_path`、迁移角色 DDL 权限与 `--no-migrate`/`migrate: false` 用法、无存量数据的新安装契约、schema 名不可配置且不承担权限/资源隔离；Git 源码依赖段落从「public 表与全局 journal 必须空闲」改为同一契约；embedded 段落补充注入池不设置 `search_path`；acceptance 清单加入 `schema-isolation`。
  - `apps/worker/README.md`：启动段落的 journal 更正为 `better_trigger.__drizzle_migrations`；新增「Database schema and migrations」小节（schema/journal 归属、共享库、`search_path` 行为、迁移账号 DDL 与关闭自动迁移、新安装边界）；embedded 注入池说明补充不写入 session 状态。
  - `docs/backend-contract.md` §2：开头新增固定 schema/journal、共享库、权限与新安装边界；删除「FK/CHECK 来自迁移 0011/0015/0016」「0011 清理孤儿后自动迁移脏库」「存量非法值会让 ADD CONSTRAINT 失败」以及「0007/0011 是 CASCADE 支点」等旧历史迁移叙述，改为基线一次建约束、目标 schema 内不兼容同名对象明确失败、CASCADE 来自初始基线。
  - `docs/architecture.md`：原则 4、`## Schema` 与风险表改为固定 schema + 专属 journal + 不设置 `search_path` + 不承担权限隔离。
  - `apps/docs`（中英同步）：`architecture/database.md` 新增 “Schema and migrations”/“Schema 与迁移” 并把 claim 示例 SQL 限定为 `better_trigger.*`；`guide/quick-start.md`、`guide/running-the-daemon.md`、`guide/embedded-mode.md`、`guide/deployment.md`、`reference/cli-and-env.md`、`architecture/roadmap.md` 同步同一契约；`reference/cli-and-env.md` 补 `--no-migrate` 与权限说明。
  - `examples/basic/README.md`：embedded 行补共库/`max:1`/host-first search_path；新增 `schema-isolation` 行；migration/constraints/retention 行删除 0007/0011 历史验收叙述；命令清单的 checks 计数同步为本次实测值（e2e 20、embedded 6、fencing 24、replay-drift 30、worker-lost 10、notify 10、health-pool 5、rolling-deploy 11、migration 4，新增 schema-isolation 7）。
  - `packages/testing/README.md` 复核后无需修改；实现侧对象名核对：`packages/db/src/constants.ts` 的 `DB_SCHEMA`/`MIGRATIONS_TABLE`、`migrate.ts` 的 `migrationsSchema`/`migrationsTable`、迁移基线 `0000_initial_schema.sql` 与各入口 SQL 均与文档一致；没有把数据库名写成必须为 `better_trigger`（`DATABASE_URL` 默认值只是默认 URL）。
- T2 · 打包与安装入口：
  - `bun pm pack`（packages/db）实际 tarball 含 `dist/index.{js,cjs,d.ts,d.cts}`、`migrations/0000_initial_schema.sql`、`migrations/meta/0000_snapshot.json`、`migrations/meta/_journal.json`（单条 0000 条目，when=1789658842156）；`files: ["dist","migrations"]` 无缺口，因此未改 `packages/db/package.json`、`packages/db/tsdown.config.ts`、`apps/worker/tsdown.config.ts`、`check-package-meta.mjs`、`verify-git-install.ts` 或 04 已完成的 git-consumer fixture。
  - 发布产物真实执行：五个 tarball（core/db/kernel/sdk/worker）装进独立临时 consumer，`node node_modules/@better-trigger/worker/dist/main.js --tasks ./tasks.mjs --database-url <独占库>` 启动打包 daemon；`/health` 200，SDK 触发 `pack-hello` → completed `"hello, packed"`，`pack-stepped`（step + `wait.for` + step）→ completed `41`，SIGTERM 优雅退出；第二个独占库上 `node embedded.mjs` 用打包 `@better-trigger/worker/embedded` 完成 embedded 触发/重放 → completed `"hi, embedded"`，stop 正常。
  - 两库 catalog 核对：`better_trigger` 下恰 9 张业务表 + `__drizzle_migrations`，4 个序列、31 个索引；`public` 表数 0；journal 恰 1 行。源码路径的真实执行由 acceptance 场景承担（下同）。
  - `check:exports`（publint/attw + worker artifact guard）与 `check:pkg-meta`（40 passed, 0 failed）通过。
  - Git 安装验证：`git rev-parse HEAD` = `43bf390c92fcb5ce6ea865295f423ac88500aaed`（本任务提交，仅含上述 19 个文档改动）；`BT_GIT_TEST_ADMIN_URL` 指向独占实例 admin 连接运行 `bun run verify:git-install` → exit 0，输出 “Git source install with lifecycle scripts disabled + strict consumer typecheck: OK (43bf390…)”，并在临时库完成真实迁移、共库同名表、共享 `max:1` 池、namespaced 触发、子任务、重放、幂等与关停。验证时工作区干净（无 dirty 警告），验证后仅 amend 追加本执行记录与队列归档，不改动被验证的源码。
- T3 · 全仓库验收（独占临时 cluster：PG 16.15，127.0.0.1:55437，trust；结束已停库并清理数据目录）：
  - `bun run check:drift` ✓；`check:deps` ✓；`lint` 9/9 ✓；`build` 7/7 ✓（含 VitePress 文档构建）；`typecheck` 14/14 ✓。
  - `bun run test --force`（`DATABASE_URL` 已设，禁用缓存）：13/13 任务通过，共 1933 用例（core 115 / db 83 / sdk 173 / testing 104 / web 272 / worker 702 / kernel 484）；kernel `test/pg` 26 个文件与 db `migrate-schema.pg.test.ts` 真实执行，无因缺 URL 跳过。首轮 `--force` 时 sdk 出现 1 个未保存用例名的瞬时失败；随后单包重跑、连续两次全量 `--force` 与 20 次 sdk 循环均全绿，判定为并发负载下的偶发且未复现（与本次改动无关）。
  - `bun run test:acceptance`：20/20 harness 通过（163.8s，exit 0），含 `schema-isolation` 7 checks、`migration` 4 checks、embedded 6、constraints 8、retention 4、health-pool 5、stats 4、notify 10、fencing 24、replay-drift 30、crash 14、worker-lost 10、graceful-restart 10、rolling-deploy 11、code-version-pinning 11、concurrency 11、run-detail 3、batch-perf 10、loop-hang 5、e2e 20；无失败、无 skip。
  - 9 张业务表、相关序列/索引与 journal 的归属由 `migration`/`schema-isolation` 场景与打包 daemon 的 catalog 查询共同核对；共库矩阵（宿主同名表、宿主 journal、共享 `max:1` 池、host-first `search_path`、独立 probe pool、重复/并发迁移）已由上述场景全覆盖。
  - `git diff --check` 干净，工作区干净；主分支启动时 main=`c8a07cd`，`git rev-list --count HEAD..main`=0（无并发改动），未 rebase/merge/push，集成留给协调器。
- 限制/风险：
  - `examples/basic/README.md` 的 checks 计数为本次实测值，后续增删断言需继续手动维护。
  - 既有问题未顺手修：`BT_STATS_ROWS` 缩小规模时 `bench:stats` 计划断言失败；tsdown `TS2688 'node'` 噪音。
  - 首轮 `bun run test --force` 的 sdk 偶发失败未复现（仅此一次），已记录以便后续观察。
