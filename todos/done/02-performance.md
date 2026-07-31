# 02 — 索引、claim 路径、数据保留

## PF1 · reaper 每 10s 全表扫 queue,且扫描无 `LIMIT` {#pf1}

**位置** `packages/kernel/src/orchestrator.ts:195-204`;索引定义见
`packages/db/src/schema.ts:125-128`

**现象** reaper 的查询是

```sql
SELECT q.id, q.run_id FROM queue q
 WHERE q.lease_until IS NOT NULL AND q.lease_until <= now()
 FOR UPDATE SKIP LOCKED
```

`queue` 上现有两个索引:`(available_at, priority DESC)` 和 `(concurrency_key)`。
**没有** `lease_until` 上的索引 → 每 10s 一次顺序扫描;并且**没有 `LIMIT`**。

**影响** 两个独立的问题:

- 队列长起来之后,每 10s 一次全表扫;
- 一次大面积 lease 过期(一批 daemon 同时挂掉)会让 reaper 在**单个事务**里锁住
  成百上千个 queue 行并逐行处理,期间 claim 路径不断被 `SKIP LOCKED` 挡开。

**建议**

```sql
CREATE INDEX queue_lease_until_idx ON queue (lease_until)
  WHERE lease_until IS NOT NULL;
```

并给扫描加 `LIMIT 100`(和 `scanWaits` / `scanCron` 的 50 保持同一风格),
剩下的下一 tick 处理。

---

## PF2 · claim 的候选索引和查询形状不匹配 {#pf2}

**位置** `packages/kernel/src/queue.ts:92-101`

**现象** 查询是 `WHERE available_at <= now() AND locked_by IS NULL
ORDER BY priority DESC, id ASC`,索引是 `(available_at, priority DESC)`。
排序键的顺序(priority, id)和索引列顺序(available_at, priority)对不上,
`locked_by IS NULL` 也完全没进索引 —— 已被占用的行仍要被读出来再过滤掉。

**影响** 队列里堆积大量已 claim 的行(高并发常态)时,claim 的候选扫描要翻过
它们才能找到 10 个可用行。这条查询在每个执行槽的每一轮循环里都会跑。

**建议** 加一个针对"可领取"这个子集的部分索引:

```sql
CREATE INDEX queue_claimable_idx ON queue (priority DESC, id)
  WHERE locked_by IS NULL;
```

`available_at <= now()` 留给 filter(时间条件不适合放进部分索引的谓词)。
改完用真实数据量跑一次 `EXPLAIN (ANALYZE, BUFFERS)` 确认走了 index scan —— 这条
建议是从查询形状推出来的,没有在有数据的库上验证过。

---

## PF3 · `claimRuns` 硬编码 `LIMIT 10`,忽略 `args.limit` {#pf3}

**位置** `packages/kernel/src/queue.ts:80-101`

**现象** 签名收 `limit`,循环里用 `if (claimed.length >= args.limit) break`,
但 SQL 里的候选窗口是写死的 `LIMIT 10`。runtime 的每个执行槽都以 `limit: 1` 调用
(`apps/worker/src/runtime.ts:128`)。

**影响** `concurrency=5` 时,5 个槽各自锁住 10 个 queue 行、只取走 1 个、然后
提交释放另外 9 个。附带效果是**优先级序被削弱**:一个槽想要的高优先级行如果正被
另一个槽的候选窗口锁着,就会被 `SKIP LOCKED` 跳过,于是执行了一个更低优先级的 run。

**建议** 让窗口跟着 limit 走(`LIMIT $n`,取 `max(limit * 2, 10)` 给并发限制的
跳过留余量);更进一步,让一个协调者批量 claim 后分发给空闲槽,把 claim 的
round-trip 数从 O(concurrency) 降到 O(1)。第一步一行就能改完,建议先做。

---

## PF4 · claim 循环里的 N+1 查询 {#pf4}

**位置** `packages/kernel/src/queue.ts:104-149`

**现象** 每个候选行都单独发两条查询:一条读 `runs`(`:107-120`),一条读
`tasks.concurrency_limit`(`:126-129`);之后还有一条读 `run_steps`。

**影响** 候选窗口 10 行 → 一次 claim 最多 21+ 条查询,而通常只成功领走 1 个。
候选 SELECT 本来就已经 `JOIN runs`,列可以顺手一起取。

**建议** 候选查询直接 `JOIN runs r` + `LEFT JOIN tasks t` 把 payload / attempt /
max_attempts / code_version / env / concurrency_key / concurrency_limit 一次取回。
`run_steps` 的读取无法合并(只对真正领到的 run 才需要),保持每个成功 claim 一条。

---

## PF5 · 唤醒全靠轮询 —— 实际代价 `[roadmap: P2 LISTEN/NOTIFY]` {#pf5}

**位置** `orchestrator.ts:59-61`(waits/cron 各 1s)、`runtime.ts:56-57`
(空转 300ms→2s)、`runs.ts:1038-1039`(`waitForResult` 每 250ms)

`docs/architecture.md` 已经把 LISTEN/NOTIFY 列进 P2。这里只补一下量化代价,
方便排期:

- **trigger → 开始执行**:空闲 daemon 的 claim 循环退避到 2s,所以冷启动延迟
  是 0–2s 均匀分布(中位 ~1s)。对"本地多 agent"这个定位,这个数字是能被感知到的。
- **`waitForResult` 的成本**:服务端 long-poll 每 250ms 一次 `SELECT`
  (`runs.ts:1042-1058`)。M 个客户端并发等结果 = 4M QPS 的纯轮询;100 个并发
  fan-out 子任务就是 400 QPS,全打在同一个 pool 上。
- **wait 唤醒的吞吐上限**:`scanWaits` 每 tick 最多 50 条 @1s = **50 次唤醒/秒**,
  cron 同理。这是个硬上限,值得写进文档而不是让人自己去读代码发现。

`NOTIFY` 落地后,前两项趋近于零,第三项变成"NOTIFY 唤醒 + 轮询兜底"。

---

## PF6 · 没有数据保留策略 {#pf6}

**位置** 全仓只有 3 处 `DELETE`(`queue.ts:55`、`orchestrator.ts:211`、
`workers.ts:145`),`runs` / `run_steps` / `logs` / `workers` 从不删除

**现象**

- `runs` / `run_steps` / `logs` 永久累积;`logs` 增长最快(每个 `ctx.logger.*`
  一行,agent 场景里步骤多、日志密)。
- **`workers` 每次进程启动插一行新的**(`workers.ts:36` 每次生成新 id),
  offline marker 只改 `status`,从不删。开发时 `bun --watch` 每次重启都是一行。
- `GET /api/v1/workers`(`dashboard.ts:341-356`)**无 LIMIT 无分页**,把历史上
  所有 worker 行一次性序列化返回。开发一周之后这个接口就开始变慢。

**影响** 本地 Postgres 无人值守地涨;dashboard 的 workers 页面逐渐变卡;
`runs_created_idx` 这类索引跟着膨胀。

**建议**

1. `better-trigger-worker prune --older-than 30d [--dry-run]` 子命令 ——
   按终态时间删 runs 及其级联行(级联需要真的建 FK,或手写按 run_id 删)。
2. orchestrator 里加一个可选的低频 GC 循环(默认关,`--retention 30d` 开启)。
3. `workers`:offline 且 `last_heartbeat_at` 超过保留期的直接删;
   `GET /workers` 加 `LIMIT` + 默认只返回 online 的。
4. 迁移里给 `logs`、`run_steps` 加 `run_id` 的 FK + `ON DELETE CASCADE`,
   这样 prune 只需要删 runs。

---

## PF7 · 并发限制用 32 位 `hashtext` 做 advisory lock 键 {#pf7}

**位置** `packages/kernel/src/queue.ts:136-140`

**现象** `SELECT pg_advisory_xact_lock(hashtext($1))`,键是 `bt:cc:${key}`。

**影响** 两个问题,都不影响正确性:

- `hashtext` 是 32 位,不同的 concurrency key 会碰撞并被迫互相串行化 ——
  表现为无法解释的吞吐下降(限流本身仍然正确)。
- advisory lock 是**全库共享的命名空间**。文档建议 daemon 独立库,但也说了
  "与业务共库"是允许的形态;这种情况下 better-trigger 的锁和业务代码自己的
  `pg_advisory_lock` 可能撞上。

**建议** 用两参数版把命名空间显式化:
`pg_advisory_xact_lock($classid, hashtext($key))`,`classid` 取一个 better-trigger
专属常量。碰撞概率不变,但至少不会和别人的锁空间重叠,而且 `pg_locks` 里能一眼
看出这是谁的锁。
