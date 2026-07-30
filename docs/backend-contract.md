# better-trigger 后端契约(v1 / M1+M2)

> ⚠️ **传输层已被取代**(见 [`architecture.md`](./architecture.md)):§4 的 Worker HTTP 协议已移除。
> worker 不再是独立进程——执行器与 kernel 同在 `better-trigger-worker` daemon 内,直连 Postgres
> (claim + lease/fencing;fencing 语义见 architecture.md),中间没有协议。
> §5 的 REST 形状仍在用,并且现在**也是 SDK 的传输面**(`betterTrigger({url})`),另加两个端点:
> `GET /runs/:id/record`(单个 run 行)与 `GET /runs/:id/result?timeoutMs=&pollMs=`(服务端 long-poll 到终态)。
> `configure()`/`BETTER_TRIGGER_API_URL` 不复存在,改为 `betterTrigger({ url })` / `BETTER_TRIGGER_URL`。
> **§3 引擎语义(重放不变量、退避公式、suspend/resume、cron、并发)继续有效且规范。**

> 本文是实现的**唯一基准**。所有包必须严格对齐这里的接口、表结构与语义。
> 类型的权威定义在 `packages/core/src/`(已写好,先读它)。本文解释语义与不变量。
>
> 范围:PRD §13 的 M0+M1+M2(task/step/重放/队列/重试 + wait.for/until + cron + triggerAndWait/batchTrigger + 并发控制)。
> 不做:事件 pub/sub(`event()`/`wait.forEvent`)、多租户 api_keys 表(用环境变量 key 骨架代替)、SaaS(builder/orchestrator/gVisor)、CLI。

## 0. 包布局与命名

> ⚠️ 下表是 M1+M2 时期的布局,现已过时;当前布局见 architecture.md §包布局。

| 目录 | npm 名 | 内容 |
|---|---|---|
| `packages/core` | `@better-trigger/core` | 共享类型、协议类型、错误、duration/backoff 工具(零运行时依赖)|
| `packages/sdk` | `better-trigger` | `task()` / ctx / 重放执行器 / worker 运行时 / HTTP 客户端 |
| `packages/server` | `@better-trigger/server` | Hono API + Drizzle schema + 队列 + 编排器 + bin 入口 |
| `examples/basic` | `@better-trigger/example-basic` | 示例任务 + worker 入口 + e2e 冒烟脚本 |
| `apps/web` | `@better-trigger/web` | Dashboard(本期接真 API,mock 作 fallback)|

- 全部 TypeScript ESM(`"type": "module"`),构建用 **tsup**(esm+cjs+dts),`"build": "tsup"`,产物 `dist/`。
- workspace 内部依赖用 `"workspace:*"`。包管理器 bun。
- 根 `package.json` 的 `workspaces` 需追加 `"examples/*"`。
- **不要运行 `bun install`**(集成阶段统一装);只写 package.json。

## 1. 配置与环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/better_trigger` | server 连接串 |
| `PORT` | `4848` | server 监听端口 |
| `BETTER_TRIGGER_HOST` | `127.0.0.1` | server 监听地址(等价 `--host`);默认只绑 loopback,仅本机可达 |
| `BETTER_TRIGGER_ALLOW_UNAUTHENTICATED` | (空) | `1`/`true` 等价 `--allow-unauthenticated`:允许非 loopback 监听且不设 API key |
| `BETTER_TRIGGER_CORS_ORIGIN` | (空) | 额外放行的浏览器来源,逗号分隔(等价 `--cors-origin`);默认只放行 loopback |
| `BETTER_TRIGGER_API_KEY` | (空) | server 端设置后,所有 API 要求 `Authorization: Bearer <key>`;不设置 = 本地模式不鉴权 |
| `BETTER_TRIGGER_BODY_LIMIT` | `1048576`(1 MiB) | 单个请求体字节上限;超出 `413 payload_too_large` |
| `BETTER_TRIGGER_MAX_BATCH` | `500` | 单次 batchTrigger 的 items 条数上限;超出 `400 bad_request` |
| `BETTER_TRIGGER_MAX_PAYLOAD_BYTES` | `262144`(256 KiB) | 单个 run 序列化后的 payload 字节上限;超出 `400 bad_request` |
| `BETTER_TRIGGER_API_URL` | `http://localhost:4848` | SDK / worker 指向的 server |
| `VITE_BT_API_URL` | `http://localhost:4848` | 前端指向的 server;**不设置时前端用 mock 数据** |

SDK 侧也可用 `configure({ apiUrl, apiKey })` 显式覆盖。

CORS(`hono/cors`):默认只放行 dashboard 自己的来源 —— http/https + `localhost` / `127.0.0.0/8` / `[::1]` + 任意端口(dev vite 端口不固定,所以做函数式 origin 校验:`new URL()` 解析后比对 host,`http://localhost.evil.com` 不算 loopback)。其余来源不回 `Access-Control-Allow-Origin`,浏览器丢弃响应。`--cors-origin <origin>`(可重复 / 逗号分隔,`*` 表示全放开)显式加白。不带 `Origin` 的调用方(SDK、curl)不受影响。

媒体类型:CORS 只管"响应交不交给页面",挡不住**简单请求** —— `Content-Type` 是 `text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data` 的跨域 POST 不发预检,请求照样到达路由、任务照样执行。所以所有读 body 的路由要求 `Content-Type: application/json`(可带 `; charset=utf-8` 等参数),否则 `400 bad_request`:要发 `application/json` 就必须预检,预检才轮得到上面的 origin 校验。无 body 的 POST(`/runs/:id/cancel`、`/runs/:id/retry`)不受影响;SDK / dashboard 本来就发 `application/json`,curl 需要显式带 `-H 'Content-Type: application/json'`。

监听姿态:默认 `127.0.0.1`。`--host` 指向非 loopback 地址时,若未设 `BETTER_TRIGGER_API_KEY`,daemon **拒绝启动**(需显式 `--allow-unauthenticated` 覆盖,启动后打印醒目警告)。容器内必须绑 `0.0.0.0`(镜像已设 `BETTER_TRIGGER_HOST`),宿主侧只发布到 loopback(`docker-compose.yml`:`127.0.0.1:4848:4848`)。

鉴权:设了 `BETTER_TRIGGER_API_KEY` 时,bearer token 先比字节长度、再用 `crypto.timingSafeEqual` 比较(`===` 会在第一个不同字节短路,响应时间会泄漏猜对了多长的前缀)。未设 key 仍是本地默认姿态,但启动时会打印一行说明(带实际绑定地址),让"不鉴权"是被知晓的状态。

输入上限:请求体由 `hono/body-limit` 在任何缓冲之前挡下(超出 → `413 payload_too_large`,路由不进入);`batchTrigger` 的 `items.length` 上限在开事务之前校验(超出 → `400 bad_request`,**调用方需自行分批**,一次请求最多 `BETTER_TRIGGER_MAX_BATCH` 条),因为每条 item 是同一个事务里的两条 INSERT,无上限的数组会把一个长写事务压在 queue 行上、堵住所有 claim;单个 payload 的字节上限在 `createRunIn` 最前面校验(超出 → `400 bad_request`,大对象放对象存储、payload 里只传引用)。三个值都可用上表的环境变量覆盖;缺失 / 非正整数 / 无法解析时回落默认值,而不是关掉上限。

## 2. 数据库 schema(Drizzle,Postgres)

单租户:所有业务表带 `project_id text NOT NULL DEFAULT 'default'` 与 `env text NOT NULL DEFAULT 'prod'`(下表省略)。迁移用 drizzle-kit 生成 SQL 并提交,server 启动时自动 `migrate()`。

```
tasks        id text PK · name text · file_path text · trigger_source text('api'|'schedule')
             · cron_pattern text · cron_tz text · retry jsonb · concurrency_limit int
             · latest_code_version text · created_at/updated_at timestamptz

runs         id text PK ('run_'+随机) · task_id text · status text
             ('queued'|'running'|'waiting'|'completed'|'failed'|'canceled')
             · payload jsonb · output jsonb · error jsonb({message,stack?,name?})
             · trigger_type text('api'|'schedule'|'subtask'|'retry'|'dashboard')
             · parent_run_id text · idempotency_key text
             · code_version text(创建时从 tasks.latest_code_version 盖章;**不是 pin**,
               claim 不按它过滤,仅用于事后追溯"这份账本是按哪版代码写的")
             · attempt int DEFAULT 1 · max_attempts int(锁定触发时的策略)
             · queued_at/started_at/finished_at/created_at/updated_at timestamptz
             UNIQUE (task_id, idempotency_key)(部分索引 WHERE idempotency_key IS NOT NULL)

run_steps    run_id text + seq int 复合 PK · kind text('step'|'wait'|'trigger-and-wait'|
             'batch-trigger'|'now'|'random'|'uuid') · label text · status text('completed'|'failed')
             · output jsonb · error jsonb · attempt int · started_at/finished_at timestamptz

queue        id bigserial PK · run_id text UNIQUE · available_at timestamptz · priority int DEFAULT 0
             · locked_by text · locked_at timestamptz · concurrency_key text
             索引 (available_at, priority desc) 与 (concurrency_key)

waits        id bigserial PK · run_id text · step_seq int · kind text('duration'|'until'|'run')
             · resume_at timestamptz · child_run_id text · status text('pending'|'completed'|'canceled')
             · created_at timestamptz;索引 (status, resume_at) 与 (child_run_id)

logs         id bigserial PK · run_id text · step_seq int · level text · message text
             · data jsonb · ts timestamptz;索引 (run_id, id)

schedules    id text PK ('sch_'+随机) · task_id text UNIQUE · cron_pattern text · cron_tz text
             · enabled boolean DEFAULT true · next_run_at timestamptz · last_run_at timestamptz
             · last_run_id text · created_at/updated_at

workers      id text PK ('wkr_'+随机) · name text · code_version text · runtime text
             · tasks jsonb(string[]) · concurrency int · started_at · last_heartbeat_at
             · status text('online'|'offline')
```

## 3. 引擎语义(不变量,重点读)

### 3.1 重放与位置键
- 每次执行 task 函数,SDK 维护一个**单调递增 seq 计数器**(从 0 开始),`ctx.step/wait/triggerAndWait/batchTrigger/now/random/uuid` **每调用一次消耗一个 seq**。
- dequeue 响应携带该 run 已完成 steps 快照;执行到 seq 时若快照中存在 `status='completed'` 的行 → **直接返回缓存 output,不执行 fn**。
- 快照中 `status='failed'` 的行视为未完成(重试时重新执行,结果 upsert 覆盖)。
- **漂移检查**:命中缓存前比对该行与调用点。`kind` 不一致(如 wait 行落到 `ctx.step()` 上)是硬信号——它由原语推导,不来自用户文本;`label` 不一致是软信号(改名无害,插入有害)。
  - `replay:'lenient'`(默认):`logger.warn` 一条 `replay drift at seq N: ...`,仍使用该缓存行。
  - `replay:'strict'`(task 级声明):抛 `AbortError` 终态失败,不重试(重试只会重放同一份错位账本)。含长 `ctx.wait` 的 task 建议开启——其账本可能跨越多次发版。

### 3.2 挂起(Suspend)
- `wait.for(d)` / `wait.until(date)`:SDK 先 `POST /runs/:id/suspend {seq, kind, resumeAt}`,成功后抛内部 `SuspendSignal`;执行器捕获后**静默结束本次执行**(不算失败),继续 poll 下一个 run。
- server 处理 suspend(单事务):插入 `waits` 行(pending)、`runs.status='waiting'`、删除该 run 的 queue 行。
- **到期恢复**(编排器 timer,每 1s 扫):`waits WHERE status='pending' AND kind IN ('duration','until') AND resume_at <= now() FOR UPDATE SKIP LOCKED` → 标记 completed、写 `run_steps` 行(seq=step_seq, kind='wait', status='completed', output=null)、`runs.status='queued'`、插 queue 行。重放时该 seq 命中缓存 → 跳过。
- 若 resumeAt 已过期(如 `wait.for("0s")`),server 直接同步走恢复路径并返回 `{resumed: true}`,SDK **不挂起继续执行**(写 step 行,seq 照常消耗)。

### 3.3 triggerAndWait(父子)
- SDK `POST /runs/:id/wait-for-run {seq, taskId, payload, options}`;server 单事务:创建子 run(`trigger_type='subtask'`, `parent_run_id`)+ 入队、插 `waits` 行(kind='run', child_run_id)、父 `status='waiting'`、删父 queue 行 → 返回 `{childRunId}`;SDK 抛 SuspendSignal。
- 子 run 到达终态(completed/failed/canceled)时,server(在 complete/fail/cancel 处理内):找 `waits WHERE child_run_id=? AND status='pending'` → completed,写父 `run_steps` 行(kind='trigger-and-wait',status='completed',output={id, ok, output?, error?}),父重新入队。
- SDK 重放命中后返回 `TaskRunResult = { id, ok: boolean, output?, error? }`(**不自动抛错**,用户自行检查;`unwrap()` 辅助函数提供)。

### 3.4 重试与失败
- 退避:`delay = min(maxMs, baseMs * factor^(attempt-1))`,jitter 乘 0.8–1.2(core 的 `computeBackoffMs`,SDK/server 共用)。默认策略 `{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300000 }`。
- step fn 抛错 → SDK 上报 `POST /runs/:id/fail { error, stepSeq, retry: <生效策略> }`。生效策略 = step 级 `options.retry` ?? task 级 ?? 默认。server:`attempt < retry.maxAttempts` → `attempt+1`、status='queued'、入队(available_at=now+backoff);否则 status='failed'。
- step 之间的用户代码抛错(不在 step 内)同样走 run fail 路径(stepSeq 省略)。
- `AbortError`(core 导出)→ 上报 `{ error, abort: true }` → 直接 failed,不重试。
- worker 上报任何接口若收到 `409 {code:'run_not_running'}`(run 已被 cancel 等)→ SDK 放弃该 run 的执行,不再上报。

### 3.5 队列与并发(SKIP LOCKED)
- dequeue 单事务:
  ```sql
  SELECT q.* FROM queue q
  WHERE q.available_at <= now() AND q.locked_at IS NULL
  ORDER BY q.priority DESC, q.id ASC
  LIMIT 10 FOR UPDATE SKIP LOCKED
  ```
  对每个候选:若其 run 的 task 不在该 worker 注册列表 → 跳过;若 task 有 `concurrency_limit`:统计 `runs.status='running' AND concurrency_key 相同` 的数量(join queue 已锁行或 runs 表计数,用 runs 表:`SELECT count(*) FROM runs r JOIN queue... ` 简化为对 runs 计数 WHERE status='running' AND task 同 concurrency_key —— 把 concurrency_key 冗余存到 runs 行避免 join)≥ limit → 跳过(留队列)。
  - 因此 **runs 表也加 `concurrency_key text` 列**。默认 key = task_id;trigger options 可覆盖。
- 取中第一个可执行的:`locked_by=workerId, locked_at=now()`,`runs.status='running', started_at=coalesce(started_at, now())`,提交,返回 run + steps 快照。
- **可见性超时** 60s:reaper(每 10s)扫 `locked_at < now()-60s` 的 queue 行 → 释放锁、`attempt+1`、`runs.status='queued'`;若 attempt 已超 max_attempts → failed(error='worker lost')。
- 心跳每 15s:`POST /workers/:id/heartbeat {runIds}` → 刷新这些 run 的 `queue.locked_at = now()` 与 worker `last_heartbeat_at`;响应含 `cancelRunIds`(server 发现已 cancel 的 run)。worker 2 分钟无心跳 → 编排器标记 `offline`。
- **长轮询**:`GET /dequeue` 挂住最多 `timeoutMs`(默认 20s,上限 30s),内部每 500ms 查一次,无任务到时返回 `{run: null}`。

### 3.6 cron 调度
- worker register 时,manifest 带 cron 的 task → upsert `schedules`(保留已有 `enabled` 状态),用 **croner** 按 timezone 算 `next_run_at`。manifest 不再含 cron 的已有 schedule → 删除。
- 编排器每 1s:`schedules WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED` → 创建 run(trigger_type='schedule')+ 入队,更新 `last_run_at/last_run_id/next_run_at`(croner 算下一次)。
- 错过的窗口(server 宕机)不补跑,只从当前时间算下一次。

### 3.7 取消 / 手动重试
- `POST /api/v1/runs/:id/cancel`:queued/waiting/running → status='canceled', finished_at=now(),删 queue 行,waits 置 canceled;若它是某父的子 run → 父的 wait 以 `{ok:false, error:{message:'child canceled'}}` 回填并恢复父。running 状态下 worker 通过心跳响应 / 409 感知后放弃。
- `POST /api/v1/runs/:id/retry`:仅 failed/canceled;**创建新 run**(同 payload,trigger_type='retry',attempt=1,无缓存 steps),返回 `{runId}`。

### 3.8 确定性替身
`ctx.now()` 返回 Date(首跑记 ISO 字符串,重放反序列化);`ctx.random()` 返回 number;`ctx.uuid()` 返回 string。三者都是 memoized 迷你 step(kind 对应),由 SDK 在**本地执行后异步上报**(与普通 step 相同上报接口,kind 不同)。

## 4. Worker 协议(全部 `/api/v1`,JSON,camelCase)

权威 TS 类型在 `packages/core/src/protocol.ts`。鉴权:`Authorization: Bearer <key>`(server 未配 key 时跳过校验)。

| 方法路径 | 请求体 → 响应 |
|---|---|
| `POST /workers/register` | `{ name?, codeVersion, runtime:'self-host', concurrency, tasks: TaskManifest[] }` → `{ workerId, heartbeatIntervalMs:15000, visibilityTimeoutMs:60000 }`。同时 upsert tasks 表 + schedules。`codeVersion` 取 `BETTER_TRIGGER_VERSION`,否则由「task id + cron + **run 函数体源码指纹**」哈希得出——改实现即变版本(打包器/压缩器不同也会变;要稳定就显式设环境变量)。 |
| `POST /workers/:id/heartbeat` | `{ runIds: string[] }` → `{ ok:true, cancelRunIds: string[] }` |
| `GET /dequeue?workerId=&timeoutMs=` | → `{ run: null }` 或 `{ run: { id, taskId, payload, attempt, maxAttempts, codeVersion, env, steps: StepSnapshot[] } }` |
| `POST /runs/:id/steps` | `{ seq, kind, label, status:'completed'\|'failed', output?, error?, attempt, startedAt, finishedAt, workerId }` → `{ ok:true }`;run 非 running → 409 `{code:'run_not_running'}` |
| `POST /runs/:id/suspend` | `{ seq, label?, kind:'duration'\|'until', resumeAt, workerId }` → `{ ok:true, resumed:false }` 或 `{ ok:true, resumed:true }`(已到期,见 3.2) |
| `POST /runs/:id/wait-for-run` | `{ seq, label?, taskId, payload, options?, workerId }` → `{ childRunId }` |
| `POST /runs/:id/batch-trigger` | `{ seq, label?, items:[{taskId,payload,options?}], workerId }` → `{ runIds: string[] }`(server 创建 N 子 run + 写 step 行 kind='batch-trigger' output={runIds},**同事务幂等**:若 step 行已存在直接返回其 output) |
| `POST /runs/:id/complete` | `{ output, workerId }` → `{ ok:true }`(终态;若有父在等,回填并唤醒) |
| `POST /runs/:id/fail` | `{ error:{message,stack?,name?}, stepSeq?, retry?, abort?, workerId }` → `{ ok:true, willRetry:boolean, nextAttemptAt? }` |
| `POST /runs/:id/logs` | `{ logs: [{ts, level:'debug'\|'info'\|'warn'\|'error', message, data?, stepSeq?}] }` → `{ ok:true }`(尽力而为,run 任何状态都接受) |

`TaskManifest = { id, name?, filePath?, cron?: { pattern, timezone? }, retry?: RetryPolicy, concurrencyLimit?, description? }`

**触发 API(给应用代码 / dashboard)**:
- `POST /trigger` `{ taskId, payload, options?: { delay?: string|number(ms), idempotencyKey?, priority?, concurrencyKey?, env? } }` → `{ runId, idempotent: boolean }`(命中幂等键返回已有 run)。taskId 未注册 → 404。
- `POST /batch-trigger` `{ items: [{taskId, payload, options?}] }` → `{ runIds }`。`items` 超过 `BETTER_TRIGGER_MAX_BATCH`(默认 500)→ 400 `bad_request`;更大的扇出由调用方切成多次请求。

## 5. Dashboard API(`/api/v1`)

> 下面这些形状的权威 TS 定义在 `packages/core/src/types.ts`(Read models /
> Dashboard read models 两节)。`apps/worker/src/types.ts` 与 `apps/web/src/api/client.ts`
> 都只是同名 alias,不再各自手写一份。

- `GET /health` → `{ ok:true, version }`
- `GET /tasks` → `{ tasks: [{ id, name, filePath, triggerSource, cronPattern, runs24h, p50Ms, p95Ms, successRate(0-100, 无运行=null), trend: number[12](近 24h 每 2h 运行数), lastRunAt }] }`(stats 用 `percentile_cont` 一次 SQL 聚合)
- `GET /runs?env=&taskId=&status=&limit=50&cursor=` → `{ runs: [{ id, taskId, status, trigger: trigger_type, codeVersion, env, attempt, durationMs(终态=finished-started; running=null), createdAt, startedAt, finishedAt }], nextCursor }`(按 created_at desc,cursor = 上页最后 run 的 created_at+id)
- `GET /runs/:id` → `{ run:{...全字段含 payload/output/error}, steps:[run_steps 全字段], waits:[...], logs:[{id, stepSeq, level, message, data, ts}] }`(logs 上限 1000 条)
- `POST /runs/:id/cancel` / `POST /runs/:id/retry`(见 3.7)
- `GET /schedules` → `{ schedules: [{ id, taskId, cronPattern, cronTz, enabled, nextRunAt, lastRunAt, lastRunStatus(查 last_run_id 的 status) }] }`
- `PATCH /schedules/:id` `{ enabled }` → 更新(enable 时重算 next_run_at)
- `GET /workers` → `{ workers: [{ id, name, codeVersion, runtime, tasks, concurrency, status, startedAt, lastHeartbeatAt }] }`

### 5.1 错误信封与错误码

所有非 2xx 走同一个信封:`{ error: { code, message } }`(生产下的 500 多一个 `requestId`,见下)。`code` 是稳定的机器可读值,SDK(`packages/sdk/src/client.ts` 的 `KERNEL_CODES`)把属于 kernel 错误家族的 code 还原成 `KernelError`(`err.code` 跨不跨网线读起来一样),其余落成 `HttpError`。union 的权威定义在 `packages/core/src/kernel-errors.ts` 的 `KernelErrorCode`;信封本身的权威定义是 `apps/worker/src/types.ts` 的 `ApiErrorBody`。

| code | 状态码 | 含义 | KernelError |
|---|---|---|---|
| `bad_request` | 400 | 入参不合法;也包括 `items` 超过 `BETTER_TRIGGER_MAX_BATCH`、payload 超过 `BETTER_TRIGGER_MAX_PAYLOAD_BYTES` | ✓ |
| `unauthorized` | 401 | 设了 `BETTER_TRIGGER_API_KEY` 但 bearer token 缺失/不匹配 | — |
| `not_found` | 404 | run / schedule 等不存在,或路由不存在 | ✓ |
| `task_not_found` | 404 | 触发的 taskId 未注册 | ✓ |
| `run_not_running` | 409 | run 已不在 running(被 cancel / 重新入队 / 已终态) | ✓ |
| `stale_lease` | 409 | 上报方的 fencing token 过期(run 已被别人重新 claim) | ✓ |
| `conflict` | 409 | 状态不允许该操作(如 retry 一个非终态 run) | ✓ |
| `payload_too_large` | 413 | 请求体超过 `BETTER_TRIGGER_BODY_LIMIT`;由中间件在进入路由之前答复 | ✓ |
| `internal_error` | 500 | 未预期的错误;生产环境 message 固定为 `internal error`,另带 `requestId` 与服务端日志对应 | — |

**500 的响应形状按 `NODE_ENV=production` 分叉**(`apps/worker/src/app.ts` 的 `app.onError`)。非 `KernelError` 的 message 是 pg / 连接层原样产出的东西:表名、列名、约束名,有时还有主机名或连接串片段。本地开发正需要这些细节;一旦按「多机共享一个 Postgres」部署,这就是白送的内部结构泄漏。所以生产下响应只给固定 message + 一个 `requestId`,完整错误(含 stack)只写服务端日志,两边用同一个 id:

| `NODE_ENV` | 500 响应体 | 服务端日志 |
|---|---|---|
| 其余(本地开发) | `{ error: { code: 'internal_error', message: <真实 message> } }` | `[server] unhandled error: …` |
| `production` | `{ error: { code: 'internal_error', message: 'internal error', requestId: 'req_…' } }` | `[server] unhandled error (req_…): …` |

`requestId` 只在生产这条分支上出现,一次失败请求一个;拿到用户报上来的 id 直接 `grep req_…` daemon 日志就能对上那条完整错误。**`KernelError` 分支(4xx / 409 / 413)两种模式下完全一致、从不脱敏** —— 那些 message 是我们自己写给调用方看的。SDK 侧这个 id 不会丢:落到 `HttpError.requestId`,同时也拼进 `err.message`。

## 6. SDK 公开 API(`better-trigger`)

```ts
import { task, configure, startWorker, AbortError } from "better-trigger";

// 两种签名
export const hello = task("hello", async (payload: { name: string }) => `hi ${payload.name}`);
export const onboarding = task({
  id: "user-onboarding",
  schema,                      // 可选,Standard Schema 或 {parse}/{safeParse} 鸭子类型(zod 兼容,不强依赖)
  retry: { maxAttempts: 5 },
  replay: "strict",            // 可选,默认 'lenient';账本与调用点错位时终态失败而非套用旧行(见 3.1)
  concurrency: { limit: 10, key: (p) => p.userId },   // key 仅在 SDK 侧触发时生效
  run: async (payload, ctx) => {
    const u = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: u.id });
    await ctx.wait.for("24h");
    await ctx.wait.until(new Date(...));
    await ctx.step("send-tips", () => sendTips(u), { retry: { maxAttempts: 2 } });
    return u.id;
  },
});
export const daily = task({ id: "daily", cron: "0 9 * * *", run: async () => {} });
// cron 也可 { pattern, timezone }

// 触发(app 代码里,HTTP 调 server)
const h = await onboarding.trigger({ userId: "u1" }, { delay: "10m", idempotencyKey: "u1" }); // → { id }
const handles = await onboarding.batchTrigger([{ payload: {...} }, ...]);                      // → [{id},...]

// task 内部:handle.trigger/triggerAndWait/batchTrigger 自动变 durable(AsyncLocalStorage 检测 ctx)
const result = await processVideo.triggerAndWait({ url });   // TaskRunResult<O>; result.ok / result.output
const out = await processVideo.triggerAndWait({ url }).unwrap?.()  // ❌ 不做链式;提供 unwrapResult(result) 辅助

// ctx 完整面:ctx.step(label, fn, opts?) / ctx.wait.for|until / ctx.logger.debug|info|warn|error
//            ctx.now() / ctx.random() / ctx.uuid() / ctx.run({id, attempt, taskId, env})
// triggerAndWait 在 task 外调用 → 抛错(必须在 run 内)

// worker 进程
await startWorker({ tasks: [hello, onboarding, daily], concurrency: 5 });
// 内部:register → N 个并发槽 long-poll dequeue → 重放执行 → 心跳循环;SIGINT/SIGTERM 优雅退出
```

类型要求:`task()` 返回 `TaskHandle<TPayload, TOutput>`,payload/output 全程类型推断;schema 存在时以 schema 推断 payload 类型。

## 7. 前端接线(apps/web)

- 新增 `src/api/client.ts`(fetch 封装)+ `src/api/adapter.ts`(server JSON → 现有 `src/types.ts` 形状)+ `src/api/hooks.ts`(`useTasks/useRuns/useRun/useSchedules`,轮询 2s 刷新,简单 useEffect+useState,**不引入新依赖**)。
- `VITE_BT_API_URL` 未设置或首次请求失败 → 整体回落 mock(现有页面零破坏);Alerts / Deployments 页面保持 mock(本期无后端)。
- 映射:`completed→success`,`waiting→frozen`,`canceled→canceled`(types.ts 的 RunStatus 加 `'canceled'`,样式灰色);Run.duration 由 durationMs 格式化("640ms"/"2.1s");started 由 createdAt 相对化("3m ago");Trace spans:t0 = min(run.startedAt, steps[].startedAt),root span = run 本身(kind 'task'),每 step/wait 一个 level-1 span(step→'fn',wait→'fn' label 前缀 "wait ",trigger-and-wait→'task',now/random/uuid 不展示);SPAN_LOGS 等价物按 stepSeq 分组,root(s0)收 stepSeq 为 null 的日志。
- RunsList 的 env 筛选传 `?env=`;点击 run 行进入 RunView 要带上选中的 runId(现有代码无参跳转,需把选中 id 提升到 App state)。

## 8. 验收(集成阶段执行,实现 agent 不必跑)

1. `bun install && bun run build && bun run typecheck` 全绿。
2. 本地 Postgres `better_trigger` 库,migration 成功。
3. e2e(examples/basic/scripts/e2e.ts):hello 完成;多 step 管道完成且 run_steps 行数正确;`wait.for("3s")` 挂起(status=waiting)后自动恢复完成;triggerAndWait 父子完成、父拿到子 output;batchTrigger 出 N 子;幂等键二次触发返回同 runId;AbortError 不重试直接 failed;故意抛错的 task 重试 maxAttempts 次后 failed;cron task 注册后 schedules 有行且 next_run_at 合理。
4. Dashboard:`bun run dev`,Tasks/Runs/Run 详情/Schedules 显示真数据。
