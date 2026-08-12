# P1-05 — 孤儿 wait 恢复排序方向反了:注释写 NULLS FIRST,实际 ASC 默认 NULLS LAST

- 优先级:P1(正确性,积压时孤儿父 run 永久卡死)
- 区域:kernel / orchestrator
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#5)

## 现状

`packages/kernel/src/orchestrator.ts:296-321`,`scanWaits` phase 1 的注释:

> "Orphan run-waits sort first (resume_at IS NULL, **NULLS FIRST in ASC**), so they are recovered before due timer waits rather than crowding them out of the LIMIT."

查询实际是 `ORDER BY resume_at ASC LIMIT 50`。Postgres 里 **ASC 默认 NULLS LAST**(NULLS FIRST 是 DESC 的默认)。孤儿 run-wait(`kind='run' AND child_run_id IS NULL`,`resume_at` 为 NULL)排在**所有**到期 timer wait 之后。

## 影响

每 tick 到期 timer wait ≥50 条时(积压、批量 wait 到期),孤儿分支永远进不了 LIMIT 窗口——C5 的 `ON DELETE SET NULL` 设计要救的父 run(子被删后靠孤儿扫描给 `ChildLostError` 唤醒)永久停在 `waiting`:无 wait 可恢复、无 queue 行、无路可回。另外这是一条写在代码里的、事实为假的不变量,后续读者会按它推理。

## 实现方案

二选一(推荐 b,彻底消除互相挤占):

- a. 最小修:`ORDER BY resume_at ASC NULLS FIRST`,注释保持。风险:孤儿如果大量堆积,反过来挤占 timer wait 的 50 名额——理论上孤儿是罕见事件,可接受。
- b. 拆分:孤儿扫描独立成一条小查询(`kind='run' AND child_run_id IS NULL LIMIT 10`),与 timer due 扫描各自 LIMIT,两类事件互不挤占;phase 2 的处理循环共用。

同时把注释改写为与实现一致的表述。

## 验收标准

- stub 测试:断言 SQL 文本含 `NULLS FIRST`(方案 a)或存在独立孤儿查询(方案 b)。
- 真 PG 行为测试(可并入 p1-22 correctness suite,若该文件后做则此处先落一个最小 vitest + DATABASE_URL 门控用例):插入 51 条已到期 timer wait + 1 条孤儿 run-wait,跑一个 tick,断言孤儿被处理(父 run 收到 `ChildLostError` 路径的结果),而不是留在 pending。
- `bun run test:acceptance`(worker-lost / constraints 场景)全绿。

## 涉及文件

- `packages/kernel/src/orchestrator.ts:296-323`(phase 1 查询与注释)、`:373-395`(ChildLostError 分支)
- `packages/kernel/test/`
