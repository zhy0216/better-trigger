# 01 — 正确性与竞态

## C1 · `scanWaits` 第二阶段用阻塞式 `FOR UPDATE`,多 daemon 下串行化 {#c1}

**位置** `packages/kernel/src/orchestrator.ts:88-140`(尤其 `:107` 的
`SELECT run_id FROM queue WHERE run_id = $1 FOR UPDATE`)

**现象** 阶段 1 用无锁读捞出最多 50 条 due wait,阶段 2 逐条开短 tx 按
queue → runs → wait 的顺序加锁。阶段 2 的三把锁都**没有** `SKIP LOCKED`。

**影响** N 个 daemon 会读到同一批 50 条 wait,然后逐条互相排队等锁:第二个实例
在每一条上都要先阻塞、拿到锁、发现 `status` 已不是 `pending`、回滚、进入下一条。
不会死锁(文件注释关于锁足迹的论证是对的),但唤醒吞吐随实例数**下降**,而
`docs/architecture.md` 明确把"N 个 daemon 共享 PG,无 leader 选举"作为卖点。

**建议** 阶段 1 直接 `FOR UPDATE SKIP LOCKED` 抢占 wait 行(拿到即归我处理),
或阶段 2 的 queue/wait 锁改 `SKIP LOCKED` —— 抢不到就跳过,下一 tick 自然重来。
后者改动更小,和 reaper 的做法一致。

---

## C2 · heartbeat 不上报 lease 丢失,旧 executor 白跑 {#c2}

**位置** `packages/kernel/src/queue.ts:234-259`、`apps/worker/src/runtime.ts:104-120`

**现象** heartbeat 的续期语句已经带了 `WHERE locked_by = $2 AND run_id = ANY(...)`,
也就是说 `rowCount` 已经能回答"这些 run 我还是不是 owner",但返回值只有
`cancelRunIds`(仅查 `status = 'canceled'`)。

**影响** reaper 把 run 抢走并交给别的 daemon 之后,原 executor 毫不知情,会一直跑到
下一次 kernel 写入才被 fencing 拒绝。如果它正卡在一个 5 分钟的 LLM step 上,这 5
分钟的算力和 token 是纯浪费,而且**同一个副作用会真实发生两次**(承诺表里 step 是
at-least-once,所以不是 bug,但这是可以显著缩小的窗口)。

**建议** heartbeat 返回 `lostRunIds = 请求的 runIds - rowCount 覆盖到的`,
runtime 收到后调 `executor.markCanceled()`(或新增语义更准的 `markLost()`)。
`Executor.checkCanceled()` 已经在每个 step 边界检查,接上即可。

---

## C3 · 关停不释放 claim,也不标记 worker offline {#c3}

**位置** `apps/worker/src/main.ts:227-238`、`apps/worker/src/runtime.ts:168-183`

**现象** `stop()` 等 `loopsDone` 或 30s(`SHUTDOWN_DRAIN_MS`)后 `process.exit(0)`。
没排干的 in-flight run 的 queue 行仍然带着 `locked_by` 和未过期的 `lease_until`;
`workers` 行仍然是 `status = 'online'`。

**影响** 一次正常的 SIGTERM(部署、`docker compose restart`)之后:

1. 未完成的 run 要等 `lease_until` 过期(默认 60s)+ reaper 周期(10s)才被接管 ——
   最坏 70s 无人推进,而这本来是可以立刻交接的;
2. reaper 走的是 `attempt + 1` 那条路(`orchestrator.ts:214-232`),**一次干净的
   重启会吃掉一次重试预算**;`max_attempts` 小的 task 可能因此直接被判 `worker lost`;
3. dashboard 会显示一个已经死掉的 worker 在线,直到 offline marker 在 2 分钟后纠正。

**建议** `stop()` 的收尾里加一步:对仍在 `inFlight` 的 run 主动
`UPDATE queue SET locked_by = NULL, locked_at = NULL, lease_until = NULL,
available_at = now() WHERE locked_by = $me`,**不递增 attempt**(这不是失败,是让位),
并 `UPDATE workers SET status = 'offline' WHERE id = $me`。这需要 kernel 上加一个
`releaseClaims({ workerId })` / `deregisterWorker({ workerId })`。

---

## C4 · reaper 把"worker 消失"和"run 失败"记成同一种 attempt 消耗 {#c4}

**位置** `packages/kernel/src/orchestrator.ts:214-232`

**现象** lease 过期时 `attempt + 1`,到达 `max_attempts` 就 `terminalFail`,
错误信息统一是 `{ message: 'worker lost' }`。

**影响** 用户配置的 `maxAttempts: 3` 语义上是"我的代码允许失败 3 次",但基础设施
抖动(部署、OOM、机器休眠)会消耗同一个预算。叠加 C3 之后,三次部署就能让一个
长 run 被判死。

**建议** 分离两个计数:`attempt`(用户代码失败)与 `recoveries`(基础设施接管),
各自有上限;或者至少让 lease 恢复不递增 `attempt`,而以一个独立的
`max_recoveries`(默认给得宽,比如 10)兜住无限循环。这会动 schema,建议和 P2 的
correctness suite 一起做,先有测试再改语义。

---

## C5 · `migrate()` 无 advisory lock,多 daemon 同时启动会竞争 {#c5}

**位置** `packages/db/src/migrate.ts:17-19`、`apps/worker/src/main.ts:164`

**现象** 每个 daemon 启动时默认 `await migrate(pool)`。drizzle 的 node-postgres
migrator 自己不取 advisory lock。

**影响** `docker compose up --scale worker=3` 或多机同时上线时,几个进程会同时
建 `drizzle.__drizzle_migrations` 并插入同一批记录 → 唯一约束冲突 / 死锁,
启动随机失败。文档同时鼓励"多 daemon 共享 PG"和"默认 auto-migrate",这两条
放在一起就要求迁移是并发安全的。

**建议** 在 `migrate()` 内包一层会话级 advisory lock:

```ts
const LOCK = 0x62_74_6d_67; // 'btmg'
await pool.query('SELECT pg_advisory_lock($1)', [LOCK]);
try { await drizzleMigrate(...); } finally {
  await pool.query('SELECT pg_advisory_unlock($1)', [LOCK]);
}
```

拿不到锁的进程会等第一个做完,然后发现无事可做 —— 正是想要的行为。

---

## C6 · 用户代码 catch 掉 `SuspendSignal` / `ExecutionDone` 会静默改变语义 {#c6}

**位置** `apps/worker/src/executor.ts:47-54`(`ExecutionDone`)、
`:395-424`(`doWait` 抛 `SuspendSignal`)

**现象** 挂起靠抛异常实现。一段这样的用户代码是完全合法的 TypeScript:

```ts
try { await ctx.wait.for('1h') } catch { /* 忽略 */ }
await sendEmail(user)            // ← 真实副作用
```

**影响** `suspendRun` 已经把 run 置为 `waiting` 并删掉 queue 行,但用户代码还在跑。
`sendEmail` **会真的发出去**,而之后所有 kernel 写入都会以 `run_not_running` 被丢弃
(executor 静默 abandon)。一小时后 run 恢复重放,邮件再发一次 —— 而且历史上找不到
任何痕迹,排查时看到的是"步骤记录里没有它,但用户收到了两封邮件"。

**建议** 三层:

1. **运行时检测(便宜且立刻有用)**:executor 在抛出 `SuspendSignal` 之前置
   `this.suspended = true`;之后任何 durable primitive 被调用就抛 `AbortError`,
   信息明确写"你的代码捕获了挂起信号";并在 `flushLogs` 前塞一条 `warn`。
   这抓不到"catch 之后只做纯副作用"的情况,但能抓到绝大多数。
2. **文档**:承诺表里加一行"不要 catch-all 包裹 durable primitive"。
3. **lint**:`packages/eslint-plugin`(P6)里加规则 —— `try` 块内出现 `ctx.wait` /
   `ctx.step` / `triggerAndWait` 且 `catch` 不重抛 → 报错。

**状态** 第 1 层(`endSignal` 检测 + `AbortError` + `warn`,executor.ts
`assertSignalNotSwallowed`)与第 2 层(`docs/architecture.md` 承诺表)已落地;
补救文案指向新的公开谓词 `isControlFlowSignal`(core/errors.ts,SDK 再导出),
它同时认得挂起信号与结束信号 —— 只判 `isSuspendSignal` 会漏掉 step 失败那条路径。
第 3 层 **延后到 P6**:需要新建 `packages/eslint-plugin`(动根 package.json /
turbo.json),不在本组范围内。

---

## C7 · `retryRun` 丢失 priority / concurrencyKey {#c7}

**位置** `packages/kernel/src/runs.ts:832-849`

**现象** 只把 `taskId` / `payload` / `env` 传给 `createRunIn`,`triggerType: 'retry'`。

**影响** 从 dashboard 手动重试一个高优先级、带 concurrency key 的 run,重试出来的
run 会退回 task 默认值:优先级归 0(排到队尾),concurrency key 变成 taskId
(和别的 run 抢同一个配额桶)。不丢 `idempotencyKey` 是对的(否则重试会撞上原 run),
但另外两个应该带过去。

**建议** `createRunIn` 的 `options` 里补 `concurrencyKey: run.concurrency_key`;
priority 需要从 queue 行读(终态 run 的 queue 行已删),所以要么在 runs 上冗余
一列 priority,要么接受重试丢优先级并写进文档。倾向前者 —— dashboard 已经在展示
"这个 run 当初是什么配置"。

---

## C8 · `appendLogs` 多一次存在性查询,且不检查 run 终态 {#c8}

**位置** `packages/kernel/src/runs.ts:858-890`

**现象** 每次 flush 先 `getRunRow` 确认 run 存在,再分块 INSERT。日志刻意不做
fencing(注释写明是 best-effort),这个决定合理。

**影响** 每次日志 flush 多一个 round-trip;`Executor` 默认 1s 一次 flush,
concurrency=5 时是 5 QPS 的纯浪费。另外一个已终态的 run 仍然可以被追加日志 ——
被 fencing 拒绝的旧 executor 的 `flushLogs` 会成功写入,历史里会出现"终态之后
还有日志"的行,排查时容易误导。

**建议** 合并成一条语句,存在性和状态一起由 SQL 判断:

```sql
INSERT INTO logs (run_id, step_seq, level, message, data, ts)
SELECT $1, ... FROM runs WHERE id = $1 AND finished_at IS NULL
```

不存在或已终态则自然写 0 行。想保留"终态后的迟到日志"的话,至少给它们打个标记列。

**状态 ✅ 已落地**(`packages/kernel/src/runs.ts` `appendLogs`)。`getRunRow` 那次
往返没了,每个 chunk 一条语句:行从 `(VALUES ...)` 子查询出,外面挂
`WHERE EXISTS (SELECT 1 FROM runs WHERE id = $1 AND finished_at IS NULL)`。
判定用 `finished_at` 而不是 `status`:全仓只有 completeRun / failRun 的终态分支 /
cancelRun 写 `finished_at`,和 `waitForResult` 的终态三元组
(`completed|failed|canceled`)一一对应,且没有任何路径把已写 `finished_at` 的 run
放回非终态(重试是新建 run,reaper 恢复的 run 从未终态过)。
不抛:run 不存在从 `not_found` 改成静默 0 行 —— 这是 `flushLogs` 想要的语义
(它把异常记成 `logFlushErrors` + 限流 warn),契约文档同步改了
(`docs/backend-contract.md` 的 `POST /runs/:id/logs` 一行)。分块仍在
(`LOG_INSERT_CHUNK = 1000`,现在 5 参/行 + 共享 `$1`)。
`VALUES` 里的 `::int/::text/::jsonb/::timestamptz` 是必需的,不是装饰:去掉后 pg 报
`column "step_seq" is of type integer but expression is of type text`(实测)。
覆盖:`packages/kernel/test/runs-logs.test.ts`(stub pool,6 例)+
`examples/basic/scripts/fencing.ts` 里的活 PG 断言 —— 单测的 stub 拦不住 SQL 本身的
退化(把 cast 全删掉,单测 6/6 照样绿,fencing 直接 42804 炸),所以终态不吸日志、
1200 行跨 chunk 全部落库这两条放在 fencing 场景里跑(`bun run test:acceptance`,
需要活 Postgres,不在默认 `bun run test` 里)。
