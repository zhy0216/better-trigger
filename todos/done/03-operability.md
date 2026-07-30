# 03 — 进程生命周期与可观测性

## O1 · pg Pool 没有 `error` 监听 → 进程崩溃 {#o1}

**位置** `packages/db/src/pool.ts:12-16`

**现象** `new Pool({ connectionString })`,之后没有任何 `pool.on('error', ...)`。

**影响** pg 的 Pool 会在**空闲连接**出错时 emit `'error'`(Postgres 重启、
`idle_in_transaction_session_timeout`、网络中断、笔记本睡眠唤醒)。这是 EventEmitter
的 `'error'` 事件:没有监听器就会被抛成未捕获异常 → daemon 整个挂掉。这是 pg 文档
里明确警告过的一个坑,而这里正好是"跑在开发机上、会被睡眠唤醒"的场景。

**建议** `createPool` 里挂上,并把 logger 做成可注入:

```ts
const pool = new Pool({ connectionString });
pool.on('error', (err) => {
  console.error('[better-trigger] idle client error:', err.message);
});
return pool;
```

不要在这里 `process.exit` —— pool 会自己丢弃坏连接并重建,记录下来就够了。

---

## O2 · daemon 没有 `unhandledRejection` / `uncaughtException` 处理 {#o2}

**位置** `apps/worker/src/main.ts:240-247`

**现象** 只有 `SIGINT` / `SIGTERM` 和 `main().catch()`。启动完成之后,任何逃逸的
rejection 都走 Node 默认行为(未处理 rejection = 进程退出),现场只有一句默认栈。

**影响** daemon 静默消失,持有的 lease 全都要等过期(见
[C3](01-correctness.md#c3)),而且日志里没有任何关于"为什么退出"的上下文。

**建议** 注册两个 handler:记录完整错误 + 当前 in-flight run id,然后走和
`shutdown()` 相同的路径(释放 claim、标记 offline)再退出。`uncaughtException`
之后继续服务是不安全的,退出是对的 —— 但要**带着交接动作**退出。

---

## O3 · 静默吞异常的位置太多,故障现场为零 {#o3}

**位置**

| 文件:行 | 吞掉了什么 |
|---|---|
| `apps/worker/src/runtime.ts:115-117` | heartbeat 失败(注释:"lease reaper 保护正确性") |
| `apps/worker/src/runtime.ts:130-136` | claim 失败(DB 抖动) |
| `apps/worker/src/runtime.ts:156-158` | executor 抛出的一切 |
| `apps/worker/src/executor.ts:555-561` | `failRun` 上报失败 |
| `apps/worker/src/executor.ts:596-599` | 日志 flush 失败 |

**现象** 每一处的 `catch {}` 单独看都有道理(注释也解释了为什么不应该让循环死掉),
但合起来的结果是:**daemon 可以在完全不产生任何日志的情况下持续失败**。
"DATABASE_URL 密码错了" 的表现是 claim 循环静默空转,dashboard 里什么都不动。

**影响** 这是最难排查的一类故障 —— 没有报错,只是"不工作"。

**建议** kernel 已经有 `KernelLogger` 这个口子(`kernel.ts:52-55`),把它一路传到
`WorkerDeps`,然后:

- 每一处 catch 至少 `logger.warn` 一次,带上是哪个循环、哪个 run;
- 加限流(同类错误每 N 秒最多一条),避免 DB 挂掉时刷屏;
- 连续失败计数暴露出去(见 [O4](#o4)),让"claim 连续失败 100 次"变成可观测事实。

---

## O4 · 没有指标,也没有结构化日志 {#o4}

**位置** 全仓 `console.log` 三处,都在 `main.ts:211-225`

**现象** 唯一的聚合视图是 dashboard 的 `computeTaskStats`
(`apps/worker/src/stats.ts`),它按 task 算 24h 的 p50/p95/成功率 —— 面向人看,
不面向告警。

**影响** 无法回答这些运维问题:队列积压多少?claim 到开始执行的延迟分布?
reaper 这一小时回收了几个 run?in-flight 是多少?

**建议** 最小可用版本:`GET /api/v1/metrics` 输出 Prometheus 文本格式,
先覆盖几个便宜且有用的量 —— `queue_depth`(按 available/claimed 分)、
`inflight_runs`、`claim_errors_total`、`reaper_recovered_total`、
`runs_total{status}`。前两个直接 SQL 查,后三个是进程内计数器。
这也顺带解决了 [O3](#o3) 里"连续失败要能被看到"的需求。

---

## O5 · `/health` 不检查数据库 {#o5}

**位置** `apps/worker/src/routes/dashboard.ts:40-43`

**现象** `return c.json({ ok: true, version })`,不碰 DB。而
`middleware.ts:22` 又特意让 `/health` 免鉴权。

**影响** "Postgres 连不上但 HTTP 进程还活着" 这个状态会被判为健康 ——
容器 healthcheck、k8s 探针、`docker compose` 的 `depends_on` 全都会被误导。
而这恰好是最需要被探测出来的故障。

**建议** 保留当前的浅层语义作为存活探针,再加一个 `?deep=1`(或
`/health/ready`)跑 `SELECT 1` + 上报 pool 的 `totalCount/idleCount/waitingCount`,
DB 不通就返回 503。`apps/worker/Dockerfile` 的 healthcheck 指向深层那个。

---

## O6 · 开箱即用体验断在"daemon 默认不带 tasks" {#o6}

**位置** `docker-compose.yml:36-58`(`command` 和 `volumes` 都被注释掉了)、
`apps/worker/src/main.ts:216-220`

**现象** `docker compose up -d` 起来的 worker 没有 `--tasks`,于是打印
"serving the API only, executing nothing";要执行任务,用户得自己取消注释
两段 YAML、先把 task 编译成 `.js`、再挂进容器。

**影响** 第一次接触这个项目的人跑完 quickstart 得到的是一个什么都不做的进程。
`docs/architecture.md` 的 P4 已经计划让 daemon 托管 dashboard 构建产物,
这条是同一个"开箱即用"问题的另一半。

**建议** compose 里放一个真的能跑的示例 task(复用 `examples/basic/src/tasks.ts`,
挂载整个 examples 目录并用 bun 直接跑 `.ts`),让 `docker compose up` 之后
dashboard 上立刻有东西可看。配合 P4 的 dashboard 托管,quickstart 就变成
"一条命令 → 浏览器里看到一个跑起来的 task"。
