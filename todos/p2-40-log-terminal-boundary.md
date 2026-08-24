# P2-40 — `appendLogs` 与终态提交之间存在快照窗口，日志可能越过 terminal 边界

- 优先级：P2（可观测性一致性 / 审计可信度）
- 区域：kernel / db
- 状态：待处理
- 来源：2026-08-24 并发状态转移审查

## 问题摘要

`appendLogs` 用一个 `INSERT ... SELECT ... WHERE EXISTS (runs.finished_at IS NULL)` 判断 run 是否仍活跃，但没有锁住 runs 行。PostgreSQL 的语句快照可能在 terminal 事务提交前看到 `finished_at IS NULL`；随后日志插入又会因为 `logs.run_id` 的外键 key-share 锁等待 terminal 事务。terminal 提交后，原语句继续执行并插入日志。

结果是日志行的提交顺序可以晚于 run 的 `finished_at`，并且在调用方给出的 `ts` 接近终态时，审计页面会看到“run 已结束但仍有日志”。当前源码注释把这当作 best-effort 的有意取舍（`runs.ts:1914-1919`），所以本条需要明确产品选择：要严格时间线，还是接受这个窗口并把它写进契约。

## 现状证据

- `packages/kernel/src/runs.ts:1901-1925` 明确说明没有 fencing、没有 `FOR UPDATE`，并承认终态瞬间可能丢日志；但没有处理“快照通过后等待 FK、终态提交、再插入”的反向情况。
- `packages/kernel/src/runs.ts:1927-1997` 的每个 chunk 都直接 `pool.query`；`WHERE EXISTS` 只读取 `finished_at`，没有与终态更新共享显式锁。
- `logs.run_id` 对 `runs.id` 的外键会取得 key-share 锁，因此该语句在并发终态更新时确实可能等待，而不是在快照失败时立即返回 0 行。

## 真 PG 复现（审查临时库，已清理）

1. 事务 A 锁住 run 行并将其更新为 completed，暂不提交。
2. 事务 B 执行 `appendLogs`。B 的语句快照仍看到 A 提交前的 running 行，`EXISTS` 为真；随后 B 在 logs 外键检查处等待 A 的行锁。
3. A 提交 terminal 状态，B 继续并插入日志。
4. 最终数据库中 run 已 completed 且存在 B 提交的日志行；日志提交次序越过 `finished_at`。

这不一定意味着每条日志的业务 `ts` 都大于 `finished_at`，但它破坏了“terminal 之后不再吸收日志”的强语义，也会让基于提交顺序或默认 `ts=now()` 的查看器产生误导。

## 影响与不变量

- 若契约承诺“终态时间之后没有新日志”，该承诺必须在线性化意义上成立，而不仅是大多数情况下成立。
- 若保留 best-effort，必须明确允许终态竞态日志被丢弃或被归入 terminal 边界，并在 API/dashboard 中保持一致解释。
- 日志修复不能重新引入 worker fencing 或让每秒 flush 长时间持有 runs 行锁，需量化锁开销。

## 推荐实现方案

### 推荐默认：严格边界（先做决定再改）

对每个 log chunk 开一个短事务：

1. `SELECT finished_at FROM runs ... FOR UPDATE`，按 namespace 校验 run 存在且未终态；
2. 只有 `finished_at IS NULL` 时插入该 chunk；
3. 提交事务。

这样 append 与 complete/fail/cancel 必然串行：先拿到 runs 锁的事务决定日志是否属于终态前，后到的事务得到 0 行/显式丢弃。若吞吐压力过大，可把 chunk 上限调小、只在 flush 的首行做一次锁检查，或引入按 run 的日志缓冲，但不能回到“快照通过后再等待 FK”的不确定窗口。

### 兼容方案：保留 best-effort，但把语义写清

如果产品确认日志允许丢失/越过终态边界，则至少：

- 在 `docs/backend-contract.md` 和 dashboard 文案中声明竞态日志可能被丢弃，且不把提交顺序当作执行顺序；
- 增加 `logs_dropped_terminal_race_total` 或等价计数，区分“run 不存在”和“终态竞态”；
- 增加回归测试锁定当前行为，避免未来代码注释与实现再次分叉。

## 验收标准

- [ ] 产品决定严格边界或 best-effort，并更新 backend contract、kernel 注释和 dashboard 查询说明。
- [ ] 严格模式下，PG 终态/append 交错测试不会出现 terminal 提交后新增日志；允许并记录被丢弃的最后几行。
- [ ] best-effort 模式下，竞态窗口有可观测计数，测试明确断言允许的结果集合。
- [ ] 大批量 chunk、FK 删除、namespace 隔离和并发 flush 回归通过，未显著延长 terminal 事务锁持有时间。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/kernel/src/runs.ts:1901-1999`
- `packages/db/src/schema.ts:309-340`（logs 外键/索引）
- `docs/backend-contract.md` 的日志与终态说明
- `packages/kernel/test/`（PG 锁交错测试）
- `apps/web` 的 run detail/log 展示（若契约选择严格边界）
