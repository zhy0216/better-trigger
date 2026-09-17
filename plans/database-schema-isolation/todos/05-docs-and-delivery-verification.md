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
