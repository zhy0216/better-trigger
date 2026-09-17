difficulty: medium
agent: inherit

# 03 · worker 查询和 embedded 集成

优先级：P1。依赖 01-db-schema-and-baseline、02-kernel-qualified-sql。独立 worktree，一个最终 commit。

## T1 · 限定 dashboard、stats、metrics 和 waiter SQL

- 要做什么：调整直接读写表的 worker 入口，涵盖任务列表、run/schedule/worker 查询、schedule 更新、统计子查询、queue/runs gauge 和 waiter 单次/批量读取。每个真实表名使用 `better_trigger`，保留参数和 namespace 过滤。
- 预计修改：`apps/worker/src/routes/dashboard.ts`、`routes/metrics.ts`、`stats.ts`、`waiters.ts`。
- 验收条件：dashboard 读写、统计、终态等待和 metrics 均访问目标表；默认业务池和独立 probe pool 都适用；取消/超时/单航班查询等既有行为无回退。
- 前置依赖：01、02 全部完成。

## T2 · 核对 daemon、prune 和 embedded 的池与迁移入口

- 要做什么：检查 `main.ts`、`embedded.ts`、runtime/app 的调用链均使用新的迁移与查询；需要时更新有关注释/接线。维持宿主池所有权、`migrate: false` 和 `--no-migrate` 语义；不设置宿主 `search_path`，也不为了 schema 注入新建一个替代共享池。
- 预计修改：按实际需要修改 `apps/worker/src/main.ts`、`embedded.ts`、`app.ts`；检查 `runtime.ts`，没有相关变更则保留。
- 验收条件：daemon 与 embedded 都能使用新基线；stop 后注入池仍可使用；`prune --dry-run` 保持不执行迁移写入；不新增动态 schema 配置或破坏 public API。
- 前置依赖：本文件 T1。

## T3 · 更新 worker 相关测试

- 要做什么：更新匹配旧未限定 SQL 的 mocks，继续验证原有路由/统计/waiter/metrics 行为；补齐 shared pool 的接线断言。真实共库执行场景由 04 整合。
- 预计修改：`apps/worker/test/dashboard-*.test.ts`、`metrics.test.ts`、`metrics-wiring.test.ts`、`stats.test.ts`、`waiters.test.ts`、`embedded.test.ts`、`host.test.ts` 及实际受影响的相关测试。
- 验收条件：相关与完整 worker 单测通过；查询 mock 能识别限定表名，已有错误、timeout、取消、namespace 和注入池生命周期覆盖保持有效。
- 前置依赖：本文件 T1、T2。

## 验证方式

```bash
bun run build
bun run --cwd apps/worker typecheck
bun run --cwd apps/worker test
bun run --cwd apps/worker check:artifacts
git diff --check
```

在本 worktree 构建并检查当前产物，不复用其他 worktree 的 `dist`。本任务只对 worker 自身变更及测试负责；全仓库真实共库 acceptance 在 04 执行。
