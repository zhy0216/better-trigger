difficulty: medium

# 03 · db FK 支撑索引、workers 部分索引与缺失 CHECK

本文件只动 `packages/db`（schema.ts、migrations/、db 测试），与其他文件不相交。

## T1 · 补 FK 支撑索引（P1）

- 做什么：Postgres FK 强制执行（CASCADE/SET NULL）按**引用列本身**查引用表，无法使用以 `(project_id, env)` 打头的复合索引。0010 把所有索引加了 namespace 前缀后，`prune` 的 `DELETE FROM runs WHERE id = ANY(...)`（`packages/kernel/src/prune.ts:288`）对每个被删 run 触发：`logs` seq scan（run_id cascade）、`waits` 两次 seq scan（run_id cascade + child_run_id SET NULL）、`runs` 自身 seq scan（parent_run_id SET NULL，**完全无索引**）、`run_retry_operations` 两次 seq scan（0015 未建任何二级索引）。新增迁移补：
  - `logs(run_id)`（或让既有 `logs_run_id_idx` 以 run_id 打头——评估后二选一，避免重复索引）
  - `waits(run_id)`、`waits(child_run_id)`
  - `runs(parent_run_id)`
  - `run_retry_operations(source_run_id)`、`run_retry_operations(retry_run_id)`
  命名遵循现有 `*_idx` 约定，迁移注释写明"支撑 FK 级联，勿加 namespace 前缀"。
- 预计文件：`packages/db/src/schema.ts`、`packages/db/migrations/0016_*.sql`（新）、db 测试。
- 验收：新迁移落库成功；`bun run check:drift` 通过（schema.ts 与迁移一致）；`packages/db/test/schema-indexes.test.ts` 断言新索引存在；真 PG 下内核/worker 套件全绿。
- 前置依赖：无。

## T2 · workers 部分索引（P2）

- 做什么：`workers` 表是追加式历史（每次进程启动一行，保留期默认关），零二级索引，却被 `orchestrator.ts:1059-1066`（30s）、`orchestrator.ts:136-148`（有到期 schedule 时每秒）、`queue.ts:802-826`（30s）、`workers.ts:207-250`（每次注册）、`prune.ts:302-333` 反复全表扫描并逐行展开 `jsonb_array_elements(w.tasks)`。在线集合很小、历史无限增长。新增部分索引 `ON workers (last_heartbeat_at) WHERE status = 'online'`（覆盖离线标记/served/stranded 扫描）。GIN(tasks) 是否追加由实测决定，默认不加、注释说明理由。
- 预计文件：`packages/db/src/schema.ts`、`packages/db/migrations/`（并入 T1 迁移或独立）、`schema-indexes.test.ts`。
- 验收：迁移落库、drift 通过、索引断言测试通过。
- 前置依赖：无。

## T3 · trigger_type / trigger_source 补 CHECK（P2）

- 做什么：契约（`docs/backend-contract.md` §2）把 `runs.trigger_type`（'api'|'schedule'|'subtask'|'retry'|'dashboard'）与 `tasks.trigger_source`（'api'|'schedule'）列为闭集，0011 已给 runs.status/run_steps/waits/workers/logs 补了 CHECK，独缺这两列——硬化不一致。新迁移补两个 CHECK，沿用 0011 的"既有值假定在集内"注释风格。
- 预计文件：`packages/db/src/schema.ts`、`packages/db/migrations/`、db 测试。
- 验收：迁移落库、drift 通过、插入越界值被拒（有对应测试）。
- 前置依赖：无。

## 备注

`workers.project_id`/`env` 两列从未被写入真实值也无查询读取（见 02/T4），属候选删除列；删列是破坏性迁移，不在本条范围，留给 roadmap 决策。

## 本文件验证

`bun run check:drift && bun run typecheck && bun run lint && bun run build && bun run test`；设置 `DATABASE_URL` 时真 PG 全量复跑（迁移只在真 PG 下被验证）。
