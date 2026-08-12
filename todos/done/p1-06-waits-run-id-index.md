# P1-06 — `waits` 缺 `run_id` 索引;`wakeParentIfWaiting` 不带 namespace 谓词,现有索引也绑不上

- 优先级:P1(性能,随历史增长恶化为逐次全表扫)
- 区域:kernel / db
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#6)

## 现状

`packages/db/src/schema.ts:289-295`:waits 仅有 `(project_id, env, status, resume_at)` 与 `(project_id, env, child_run_id)` 两个索引。

- `wakeParentIfWaiting`(`packages/kernel/src/runs.ts:1471-1474`)按 `WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'` 查——**没有 project_id/env 谓词**,`waits_child_run_idx` 的前导列绑不上,索引不可用。(它能通过 C2 的 namespace sweep 测试,是因为 SELECT 列表里恰好有 `project_id, env` 字样——见 p2-28。)
- 按 `run_id` 查的语句完全没有索引覆盖:`terminalFail` / `cancelRun` 的 waits 清扫(`runs.ts:1574-1577`、`:1721-1724`)、`waitForChildRun` 的 pending-wait 探测(`:1299-1303`)、`getRunDetail`(`:2163-2167`,连 status 过滤都没有)、prune 的计数(`prune.ts:260-263`)。

waits 行只翻状态、从不删除,retention 默认关闭 → 表无界增长。

## 影响

`wakeParentIfWaiting` 在**每个**带 `parent_run_id` 的 run 终态时执行——包括所有 `batchTriggerChild` 子任务,不只 `triggerAndWait`。500 项 fan-out 收尾 = 500 次顺序全表扫。长期运行的安装上,每个子任务完成、每次 terminal fail、每次 cancel、每次 run detail 页都退化为全表扫。

## 实现方案

1. schema 增加 `index('waits_run_idx').on(projectId, env, runId)`(如要覆盖 `waitForChildRun` 的探测可加 `stepSeq` 尾列),`drizzle-kit generate` 出迁移,`bun run check:drift` 通过。
2. `wakeParentIfWaiting` 的查询补 namespace 谓词:调用方(completeRun/failRun)手里有子 run 的 `RunRow`,把 `project_id/env` 传进去,使 `waits_child_run_idx` 前导列可绑。
3. `getRunDetail` 的 waits 查询补 namespace 谓词(路由层已知 namespace)。
4. 在 `packages/db/test/schema-indexes.test.ts` 把新索引 DDL 钉住(与 queue 两个索引同样待遇)。
5. (与 p2-28 联动)namespace sweep 测试的 marker 收紧后,本条修复正是让 `runs.ts:1471` 那条语句真正合规的改动——两条 todo 一起做可互为验证。

## 验收标准

- 迁移生成且 `check:drift` 通过;`schema-indexes.test.ts` 钉住 `waits_run_idx` DDL。
- 真 PG(可挂在 claim-scan-bench 或新 bench):对 10 万行 waits,`wakeParentIfWaiting` 与 cancel 清扫的 EXPLAIN 是 Index Scan 而非 Seq Scan。
- 现有验收场景(notify、worker-lost、retention)全绿。

## 涉及文件

- `packages/db/src/schema.ts:289-295`、`packages/db/migrations/`(新增)
- `packages/kernel/src/runs.ts:1471-1474`、`:1574-1577`、`:1721-1724`、`:2163-2167`
- `packages/kernel/src/prune.ts:260-263`
- `packages/db/test/schema-indexes.test.ts`
