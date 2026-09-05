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
