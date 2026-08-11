# Performance TODOs

## PF1 — 修正 Dashboard task stats 的时间窗口和查询计划

**现状**

`computeTaskStats()` 的注释说是“last 24h”，但 p50、p95、success rate 和 `last_run_at` 的聚合都读整个 runs 表；只有 `runs24h` 使用了 24 小时 FILTER。

`/tasks` 每次请求都会执行 task list + 两条聚合查询，而 web hook 默认每 2 秒轮询一次。Retention 默认关闭时，这个查询成本会随历史 run 数量单调增长。

**修复方向**

1. 明确每个指标的时间语义：
   - 24h p50/p95/success 使用 `created_at >= now() - interval '24 hours'`
   - last run 如需全历史，单独命名并单独查询
2. 使用匹配时间窗口和 task 的索引；用 `EXPLAIN (ANALYZE, BUFFERS)` 固定基准。
3. 中长期将统计改为分钟/小时 rollup 或 materialized view。
4. Dashboard 对 tasks stats 做 5–30 秒短缓存，不必跟 run list 同频刷新。
5. 为 p50/p95、成功率和窗口边界增加测试，避免再次发生口径漂移。

**验收标准**

- 100 万历史 runs 下 `/tasks` 的 p95 延迟和 pool 使用量仍在目标内。
- 24h 之前的 run 不会影响 24h p50/p95/success。
- 无 run 的 task 不触发全表 percentile 扫描。

涉及文件：

- [apps/worker/src/stats.ts](/Users/yang/workspace/better-trigger/apps/worker/src/stats.ts:23)
- [apps/worker/src/routes/dashboard.ts](/Users/yang/workspace/better-trigger/apps/worker/src/routes/dashboard.ts:121)

## PF2 — 通知优先，轮询兜底

**现状**

当前有多条轮询链路：

- worker 空闲 claim poll
- wait due scanner
- cron scanner
- SDK `waitForResult()` 服务端轮询
- Dashboard 每 2 秒 poll

在大量等待者或大量长 wait 时，数据库会承受大量重复 `SELECT`。架构文档也明确把 LISTEN/NOTIFY 列为后续工作。

**修复方向**

1. 在 trigger/enqueue、resume、complete/fail/cancel、schedule due 等事务成功提交后发送 `pg_notify`。
2. daemon 使用长连接 LISTEN：
   - 有通知时立即唤醒 claim/wait/result resolver
   - 没有通知时保留现有轮询作为兜底
3. 对 `waitForResult` 尽量使用进程内 waiter registry，避免每个 HTTP 请求独立打 PG。
4. 通知 payload 只放 run id/namespace，不放业务 payload。
5. 加通知丢失、重连、重复通知、跨 daemon 的测试；通知只能优化延迟，不能成为正确性的唯一来源。

**验收标准**

- 新 run 在有空闲 worker 时无需等待完整 idle backoff。
- 大量 `result()` waiter 不再产生线性 4 QPS 查询。
- LISTEN 断开时，系统仍能靠轮询恢复，且不会重复执行。

## PF3 — run detail 使用一致快照并支持分页

**现状**

run detail 先后读取 run、steps、waits、logs 多次；在 run 正在变化时，返回内容可能来自不同时间点。日志固定取最早 1000 条，长任务的最新错误可能被截掉。

**修复方向**

- 让 kernel 的 detail read 在一个短事务中读取，优先使用 `REPEATABLE READ` 或单条 SQL 聚合。
- 统一 worker route 和 kernel 的 detail read，避免两份 SQL 漂移。
- logs 增加基于 `id` 的 cursor：
  - 默认返回最新 N 条并按时间正序展示
  - 支持向前翻页读取更早日志
- steps/waits 也要有上限和分页策略，避免超长 agent run 生成超大 JSON。
- runs list 在 Dashboard 真正消费 `nextCursor`，而不是永久只展示第一页。

**验收标准**

- detail response 中 run status 与 steps/waits/logs 来自同一个一致性快照。
- 1200 条日志时默认能看到最后一条错误。
- 大 run 的 response 大小有明确上限。

涉及文件：

- [packages/kernel/src/runs.ts](/Users/yang/workspace/better-trigger/packages/kernel/src/runs.ts:1185)
- [apps/worker/src/routes/dashboard.ts](/Users/yang/workspace/better-trigger/apps/worker/src/routes/dashboard.ts:242)

## PF4 — health/metrics 超时不能持续占用 pool

**现状**

health/metrics 使用 `Promise.race` 超时，但 race 超时并不会取消已经发给 pg 的 query。数据库或网络半挂时，查询可能继续占用连接，连续 probe 会把默认 pool 慢慢耗尽。

**修复方向**

- 使用独立的 health pool，或显式 `pool.connect()` + `client.release()`。
- 给 probe query 设置 PostgreSQL `statement_timeout`/连接超时。
- 如 driver 支持，使用 AbortSignal/cancel request 真正取消 query。
- metrics 在 DB 不可用时继续输出 `db_up 0`，但不要创建无限 pending query。

**验收标准**

- 模拟一个永不返回的 probe，2 秒后 HTTP 返回且连接归还 pool。
- 连续 100 次失败 scrape 后，业务 query 仍能获得连接。

## PF5 — 降低 batch trigger 和 claim 的 round-trip

**现状**

`batchTrigger` 上限虽为 500，但每个 item 都会进入 `createRunIn`，重复读取 task 配置并执行多次 INSERT；长事务会占住 queue/数据库资源。

**修复方向**

- 事务开始时批量预加载 task retry/concurrency/codeVersion 配置。
- runs 和 queue 使用批量 INSERT，幂等冲突后再批量回读已有 run。
- 对 batch 大小设置按 payload 总字节数的限制，而不仅是 item 数。
- 对 claim candidate window、advisory lock、concurrency count 做真实数据量下的 EXPLAIN benchmark。

**验收标准**

- 500 item batch 的 SQL round-trip 数量不随 item 数线性增长。
- batch 失败仍然保持 all-or-nothing。
- 大 backlog 下 claim 延迟不会因大量 delayed rows 明显恶化。
