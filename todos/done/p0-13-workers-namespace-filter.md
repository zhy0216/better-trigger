# P0-13 — `GET /workers` 按错误列过滤，多 namespace 下隔离失效

- 优先级：P0（正确性 / namespace 隔离破坏）
- 区域：apps/worker（route + test）、packages/kernel（对照）
- 状态：已完成（2026-09-02）
- 来源：2026-09-02 全仓库审查（第二轮）

## 问题摘要

`GET /workers` 按 `workers.project_id / workers.env` 两列过滤，但 `registerWorker` 的
INSERT 从不写这两列（全表都是列默认值 `default`/`prod`）；worker 真正的 namespace
成员关系在 `namespaces` jsonb 数组里。后果：

- 指向 `default/prod` 的 dashboard 会列出**所有** worker，包括只服务其它
  namespace 的（泄露其它 namespace 的 worker 元数据）。
- `?projectId=acme&env=staging` 的 dashboard 永远看不到自己的 worker。

## 现状证据

- `apps/worker/src/routes/dashboard.ts:519-527`：
  `clauses.push('project_id = $N AND env = $N+1')`，注释还自称
  「Workers are namespace rows too」。
- `packages/kernel/src/workers.ts:84-97`：INSERT 列清单为
  `(id, name, code_version, runtime, tasks, namespaces, concurrency, started_at, last_heartbeat_at, status)`，
  不含 `project_id/env`。
- `apps/worker/test/dashboard-workers.test.ts:62,76`：测试把错误谓词
  `project_id = $2 AND env = $3` 固化成了断言。
- 正确写法已有两处先例：`packages/kernel/src/prune.ts:316-319`（`pruneWorkers`）与
  `packages/kernel/src/queue.ts:764-773`（stranded scan），均用
  `EXISTS (SELECT 1 FROM jsonb_array_elements(namespaces) ...)` 判断成员关系。

## 不变量

- C2 namespace 隔离：一个 namespace 的读面不得返回只属于其它 namespace 的执行节点。
- `workers.project_id/env` 两列要么开始维护、要么不再用于过滤——本次选择后者
  （与 prune/stranded scan 的既有口径一致）。

## 推荐实现方案

- dashboard route 的谓词改为与 `pruneWorkers` 相同的
  `EXISTS (SELECT 1 FROM jsonb_array_elements(namespaces) n WHERE n->>'projectId' = $x AND n->>'env' = $y)`；
  若该谓词已有共享构造函数（如 `namespacePredicate`），直接复用。
- 更新 `dashboard-workers.test.ts:62,76` 的断言为新谓词，并补一条多 namespace
  用例：注册只服务 `acme/staging` 的 worker 后，`default/prod` 查询不得返回它，
  `acme/staging` 查询必须返回它。

## 验收标准

- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。
- [ ] 新增多 namespace 隔离用例在真 PG 或单测中通过。

## 涉及文件

- `apps/worker/src/routes/dashboard.ts`、`apps/worker/test/dashboard-workers.test.ts`
