difficulty: hard

# 测试数据库隔离、连接参数与资源生命周期

对应 plan.md：F8、F9、F10。执行模型固定为 Codex YOLO / gpt-6-astra / xhigh。

## T1 · 每次 resetDb 创建自己拥有的唯一实例

- 做什么：把固定名称的 DROP/CREATE 改为默认分配唯一实际库名并 CREATE；使用逻辑前缀+随机唯一后缀，最后实际名称受 PostgreSQL 63-byte 限制，SQL、URL、返回 name 一致，明确处理大写。envVar 名称覆盖保留为逻辑前缀并说明，不再默认 FORCE DROP 该字面名称。
- 预计修改：packages/testing/src/database.ts、packages/testing/test/database.test.ts、packages/kernel/test/pg/helpers.ts、packages/testing/src/scenario.ts、packages/testing/README.md（新增）；使用固定库名假设的 examples/basic/scripts 与 examples/basic/README.md 仅作必要适配。
- 验收：同一逻辑名称并发调用得到不同库；两个并发进程/checkout 不删对方数据库或断连接；超长/大写/非法名称可预测且 URL 可连接；显式命名前缀不会删除预先存在的同名库。记录所有权后仅清理自己创建成功的实例。
- 前置依赖：03-scenario-verdict-redaction。

## T2 · 派生连接保留传输配置

- 做什么：采用 URL pathname 替换方式创建 admin 和 scenario URL，保留 driver 支持的连接参数（尤其 sslmode/ssl 相关配置），移除 fragment；更新原有“丢 query”断言及文档。排查 baseUrl/databaseUrlFor 的调用者，避免手工字符串拼接把 query 放到 pathname 前。
- 预计修改：database.ts、database.test.ts 及真实调用者；不得更改生产 createPool 的安全默认值来迁就测试。
- 验收：编码凭据、非默认端口、sslmode=require 等配置在派生 URL 中保持，库名正确替换；admin 与目标池收到正确 URL；日志沿用 03 脱敏。
- 前置依赖：本文件 T1。

## T3 · 成功和失败路径清理本次资源

- 做什么：migrate 失败后尽力关闭池并删除本次创建的库，保留主错误和 cleanup 诊断；默认 scenario 结束 drop 自己的库；需要调试保留时提供明确选择并记录未清理状态。不能因池 end 失败就悄悄报 cleanup 成功。
- 预计修改：database.ts、scenario.ts、相关 tests 与 README。
- 验收：成功、body 失败、migrate 失败、cleanup 失败、重复 end/drop 路径均有测试；清理失败进入 03 的失败判定；从不删除不属于本次调用的库。
- 前置依赖：本文件 T1、T2。

## T4 · 真 PostgreSQL 并发验收

- 做什么：在独占临时 PG 中验证两个相同 suite 并发，以及完整 kernel PG 与 acceptance。
- 预计修改：必要的测试 fixtures/测试；不更改业务内核。
- 验收：bun run --cwd packages/testing test；显式 DATABASE_URL 的 kernel 全套；bun run test:acceptance 19 场景通过；新增并发探针证明独立创建、互不干扰、默认结束后无本轮残库。容器仅删除本任务创建的。
- 前置依赖：本文件 T1～T3。

## 执行约束与仓库校验

全程只用 Codex CLI YOLO、`gpt-6-astra`、`xhigh`，包括后续修复/rebase；difficulty 仅描述复杂度，不改变模型。先读 ../plan.md 与仓库 agent.md。一个 todo 一个 worktree、一个最终 commit，只修改本任务范围；不 push、不操作原分支。只有全部验收完成才移入 done/，并只更新 README 中本任务状态。

针对性校验完成后，在本 worktree 顺序运行 `bun run lint`、`bun run typecheck`、`bun run build`、`bun run test -- --force`、`git diff --check`。不要用 `bun run --bun test` 替代标准命令。新 worktree 缺依赖时 `bun install --frozen-lockfile`。数据库测试必须使用本任务独占临时 PostgreSQL，记录并清理所建资源；不能对用户现有库执行 reset。

## 完成记录 · 2026-09-05

- T1：每次 CREATE 使用小写逻辑前缀（最多 30 ASCII bytes）+ `_` + 32 位随机十六进制后缀，最终最多 63 bytes。SQL quote、URL pathname 和返回 name 一致；非法前缀在获取资源前拒绝。envVar 只覆盖前缀；CREATE 确认成功后才记录所有权，失败/重名不执行 DROP。
- T2：admin、目标及 cleanup URL 都由同一份创建时连接配置派生，保留编码凭据、非默认端口、SSL 参数与 query，移除 fragment。单元测试检查 admin/目标/cleanup 池参数及 env 后续变化；真实 PG 检查 current_database 和 application_name。未改生产 createPool。
- T3：migration/setup 失败后关闭池并尝试 DROP 本次实例；主错误保持原值，复合失败使用 AggregateError 保存 cause/errors。end/drop 并发或重复调用共享第一次结果，失败不会变成成功；end 失败仍尝试 DROP。scenario 默认最后 DROP，keepDatabase / BT_KEEP_TEST_DATABASE=1 明确保留并输出未删除状态，保留时 close 失败仍进入 03 的失败判定。成功、body/falsy throw、migration、CREATE、池创建、池关闭、DROP、admin 关闭、重复清理与保留路径均有测试。
- T4：新增真实 PG 测试同时运行两个相同 scenario 的 Bun 进程，双方保持事务与原连接；先结束一方后检查其库已删除，另一方及预先创建的同名前缀库仍可用；全部结束后没有本轮实例。额外两个 kernel PG smoke suite 同时通过。完整 kernel 和 19 个 acceptance 场景通过。

### 修改范围

- `packages/testing/src/database.ts`、`src/scenario.ts`。
- `packages/testing/test/database.test.ts`、`test/scenario.test.ts`、新增 `test/database.pg.test.ts` 和 `test/fixtures/database-scenario.ts`。
- 新增 `packages/testing/README.md`；`packages/kernel/test/pg/helpers.ts` 仅更新命名/生命周期说明。
- `examples/basic/README.md`；`examples/basic/scripts/` 内 `acceptance.ts`、`batch-perf.ts`、`claim-scan-bench.ts`、`code-version-pinning.ts`、`concurrency.ts`、`constraints.ts`、`crash.ts`、`e2e.ts`、`fencing.ts`、`graceful-restart.ts`、`health-pool.ts`、`loop-hang.ts`、`migration.ts`、`notify.ts`、`replay-drift.ts`、`retention.ts`、`rolling-deploy.ts`、`run-detail.ts`、`stats-bench.ts`、`stats.ts`、`worker-lost.ts`：仅适配前缀说明、移除重复 DROP 注册及其过时注释。
- 本 todo 归档；队列 README 仅修改 04 行状态与链接。

### 校验结果

所有命令使用 Bun 1.4.0。新 worktree 先 `bun install --frozen-lockfile`，无依赖/lockfile 变更。以下 PG 命令的 DATABASE_URL 仅指向本任务独占临时容器，未使用继承的用户数据库连接。

| 命令 / 检查 | 结果 |
|---|---|
| `env -u DATABASE_URL bun run --cwd packages/testing test` | 102 passed，2 PG tests skipped |
| 显式临时 `DATABASE_URL` + `bun run --cwd packages/testing test` | 6 files，104 passed |
| 显式临时 `DATABASE_URL` + `bun run --cwd packages/kernel test` | 58 files，393 passed，36.99s |
| 两个并发进程各运行 `bun run --cwd packages/kernel test test/pg/smoke.test.ts` | 同时启动，各 1 passed |
| 显式临时 `DATABASE_URL` + `bun run test:acceptance` | 19/19 harnesses passed，164.5s |
| `env -u DATABASE_URL bun run lint` | exit 0，9 tasks successful |
| `env -u DATABASE_URL bun run typecheck` | exit 0，14 tasks successful |
| `env -u DATABASE_URL bun run build` | exit 0，7 tasks successful |
| `env -u DATABASE_URL bun run test -- --force` | exit 0，13 tasks，0 cached；1,410 passed，97 PG tests skipped |
| `git diff --check` | exit 0 |

最后五项在针对性验证结束后按表中顺序执行。104 个 testing 测试包含前置 03 的脱敏和 verdict 回归。初次针对性 lint 的两处 `preserve-caught-error` 报错已通过集中保留主错误/cleanup 错误的 helper 修复，没有禁用规则；随后针对性 lint/typecheck/test 和最终仓库 gates 均通过。

资源：独占 `postgres:16-alpine` 容器 `275edd5bc03539eb98d53a688cb26c7f90e1f46fe5585c205506b346898530a6`，随机 loopback 端口 `32773`。PG 测试结束后 `pg_database` 仅有 postgres/template0/template1。仅删除上述容器，确认不存在，并删除本任务临时凭据文件。10 份本任务日志检查未包含该临时密码。

日志：`/tmp/bt-task04-{db-build,prep-build,kernel-pg,kernel-concurrent-a,kernel-concurrent-b,acceptance,lint,typecheck,build,test}.log`。这些日志不进入提交。

风险 / blocker：无 blocker。显式保留、硬终止进程或 CREATE 确认丢失可能留下实例；工具不按前缀猜测所有权或清扫他人的库，手工处理与重复失败语义已写入 testing README。保留既有 TS7 experimental 警告及任务 10 已记录的 worker 测试 stub 诊断，未扩大本任务修改范围。
