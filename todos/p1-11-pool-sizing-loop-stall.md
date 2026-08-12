# P1-11 — 业务连接池无 sizing/无超时;一条卡死语句让 orchestrator 循环永久停摆且零指标

- 优先级:P1(可靠性,两个审查方向独立发现)
- 区域:db / worker / kernel
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#11)

## 现状

- `packages/db/src/pool.ts:20-35`:`createPool` 就是 `new Pool({ connectionString })`——pg 默认 `max: 10`、`connectionTimeoutMillis: 0`(checkout 无限等待)、无 `statement_timeout`。同文件的 `createHealthPool`(PF4)三样全设了,业务池一样没设。
- `apps/worker/src/main.ts:835` 调 `createPool(opts.databaseUrl)`,没有任何 sizing 参数;`--concurrency`(默认 5)只校验 >0,与池大小完全脱节。争抢这 10 个连接的:N 个 claim 循环、心跳、每个 executor 的 reportStep/failRun/appendLogs、四个 orchestrator 循环、waiter registry 的每请求 readRun + 1s sweep、所有 dashboard 读路由。
- `packages/kernel/src/orchestrator.ts:263-282`:循环重入护栏 `if (stopped || running[key]) return`——一个 tick 卡死(如 `scanWaits` 的 position-1 `FOR UPDATE` 阻塞,`:344-347`,且无 statement_timeout 意味着可以永远阻塞),后续所有 tick 被护栏吞掉,循环**永久死亡**,`loopErrors` 保持 0,无任何指标暴露。

## 影响

(a) `--concurrency 20` 对 10 连接:claim 循环在 `pool.connect()` 上无限排队、无报错;心跳被饿死 → lease 被 reaper 收走,run 白烧 recoveries。(b) 一次锁等待 → wait/cron/reaper 某个循环无声死亡,timer 不再唤醒、cron 不再触发,运维只能看到"系统慢了"而看不到原因。

## 实现方案

1. `createPool` 增加 options:`{ max?, connectionTimeoutMillis?, statementTimeoutMs? }`,内部映射到 pg Pool 配置(`statement_timeout` 经 startup packet 下发,同 health pool 的做法)。
2. daemon 侧推导默认值:`max = concurrency + ORCHESTRATOR_HEADROOM`(建议 headroom 8:四个循环 + 心跳 + waiter sweep + HTTP 余量),env `BETTER_TRIGGER_POOL_MAX` 覆盖;`connectionTimeoutMillis` 默认 10s;业务池 `statement_timeout` 默认 30s、env 可调可关(0)。`--help`/README/.env.example 记入(接 p2-26)。
3. 池饱和要可见:checkout 超时的错误路径打进日志 + `/metrics` 计数器(如 `better_trigger_pool_checkout_timeouts_total`)。
4. orchestrator 循环反停摆:
   - tick 包 try/finally,确保 `running[key]` 必然复位(现有 finally 若已有则确认);
   - 有了 statement_timeout,卡死语句会在 30s 内报错 → `loopErrors++`、下一 tick 恢复;
   - 增加 per-loop 健康 gauge:`better_trigger_loop_last_success_timestamp{loop}`,任何循环停摆在 metrics 上直接可见。
5. `docs`:worker README 的运维小节写清 pool 推导公式与三个新 env。

## 验收标准

- 单测:`createPool` 正确传递三项配置;daemon 推导逻辑(concurrency→max)有测试。
- 真 PG:`--concurrency 20` 冒烟,claim/心跳无饥饿(health-pool 场景扩展);人为 `pg_advisory_lock` 卡住 waits 扫描 35s,断言循环报错后自愈、`loopErrors` 增长、gauge 反映停顿。
- `/metrics` 输出含新 gauge 与计数器;README/.env.example 更新。

## 涉及文件

- `packages/db/src/pool.ts:20-35`
- `apps/worker/src/main.ts:835`、`:360`(--concurrency)
- `packages/kernel/src/orchestrator.ts:263-282`、`:344-347`
- `apps/worker/src/metrics.ts`(或等价文件)、`apps/worker/README.md`、`.env.example`
