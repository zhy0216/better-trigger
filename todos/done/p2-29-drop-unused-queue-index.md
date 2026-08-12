# P2-29 — `queue_available_priority_idx` 无任何查询使用,在写入最热的表上白付维护成本

- 优先级:P2(性能卫生)
- 区域:db
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」kernel #9)

## 现状

`packages/db/src/schema.ts:222`(迁移 `0010_young_forgotten_one.sql:36`)的 `queue_available_priority_idx` 是 `(project_id, env, available_at, priority DESC NULLS LAST)`。全仓 grep:没有查询按 `available_at` 过滤/排序(claim 扫描里它只是残余过滤条件,bench 证实走的是 `queue_claimable_idx`);reaper 用 `queue_lease_until_idx`。它是 PF2 的 partial index 取代掉的前代索引。

queue 是全系统写入最热的表(每 trigger 一 insert、每 claim 一 update、每释放一 update、每终态一 delete),四个索引里有一个纯属写放大与膨胀。

## 实现方案

1. (可选、建议)在任何长期运行的安装上确认:`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'queue_available_priority_idx'` ≈ 0。
2. schema.ts 删除该索引定义,`drizzle-kit generate` 出 DROP INDEX 迁移,`check:drift` 通过。
3. `queue_concurrency_idx` **保留**并加注释:kernel 今天同样不用它,但它是并发计数将来移出 runs 表时的天然支撑——注明这个保留理由,防止下次 sweep 误删。
4. `schema-indexes.test.ts` 同步(移除对该索引的钉住,若有)。

## 验收标准

- 迁移干净应用(migration.ts 验收场景绿);`check:drift` 绿。
- claim-scan-bench 的 plan 断言不变(证明删的确实是死索引)。

## 涉及文件

- `packages/db/src/schema.ts:222`、`packages/db/migrations/`(新增 DROP)
- `packages/db/test/schema-indexes.test.ts`
