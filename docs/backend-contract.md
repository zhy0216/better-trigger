# better-trigger 后端契约(v1 / M1+M2)

> ⚠️ **传输层已被取代**(见 [`architecture.md`](./architecture.md)):§4 的 Worker HTTP 协议已移除。
> worker 不再是独立进程——执行器与 kernel 同在 `better-trigger-worker` daemon 内,直连 Postgres
> (claim + lease/fencing;fencing 语义见 architecture.md),中间没有协议。
> §5 的 REST 形状仍在用,并且现在**也是 SDK 的传输面**(`betterTrigger({url})`),另加两个端点:
> `GET /runs/:id/record`(单个 run 行)与 `GET /runs/:id/result?timeoutMs=&pollMs=`(服务端 long-poll 到终态;
> long-poll 内部仍是 `pollMs`(默认 250ms)一次 `SELECT`,每个等待者 4 QPS —— 轮询代价的完整数字见
> architecture.md「P2 · 轮询代价」)。
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
| `BETTER_TRIGGER_MAX_RECOVERIES` | `10` | 创建 run 时盖章的 `max_recoveries`:reaper 最多为这个 run 接管几次(worker 消失)。**与 `maxAttempts` 是两本账**(见 §3.5);`0` 合法,表示"lease 一过期就判死",非整数 / 负数回落默认值 |
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
             ('queued'|'running'|'waiting'|'completed'|'failed'|'canceled',
             **CHECK 约束**,见下)
             · payload jsonb · output jsonb · error jsonb({message,stack?,name?})
             · trigger_type text('api'|'schedule'|'subtask'|'retry'|'dashboard')
             · parent_run_id text(**FK → runs(id) ON DELETE SET NULL**:
               父 run 被删时子 run 活着,只清血缘指针 —— CASCADE 会误删还在执行的
               子 run,RESTRICT 会让 prune 在批量删除父子对时失败;见 C5)
             · idempotency_key text
             · code_version text(创建时从 tasks.latest_code_version 盖章;**不是 pin**,
               claim 不按它过滤,仅用于事后追溯"这份账本是按哪版代码写的")
             · attempt int DEFAULT 1 · max_attempts int(锁定触发时的策略)
             · recoveries int DEFAULT 0 · max_recoveries int DEFAULT 10
               (基础设施接管预算,与 attempt 分开记账;见 §3.5)
             · concurrency_key text(见 §3.5)· priority int DEFAULT 0
               (**调度器不读这两列**,它读的是 queue 行上的同名列;这里是创建时的
                冗余副本 —— queue 行在终态/挂起时就被删了,而"这个 run 当初是按什么
                配置触发的"要在 run 死后 / 挂起期间仍然可答。**每一处重新 INSERT
                queue 行的路径都必须从这里读回 priority**:手动重试(§3.7)、定时
                wait 到期恢复、以及父 run 被子 run 唤醒 —— 这三条都是先删 queue 行
                再重建,写死 0 就等于"等过一次就掉到队尾"。失败重试 / reaper 接管 /
                优雅关停归还走的是 UPDATE,queue 行还在,priority 自然保住)
             · queued_at/started_at/finished_at/created_at/updated_at timestamptz
             UNIQUE (task_id, idempotency_key)(部分索引 WHERE idempotency_key IS NOT NULL)
             CHECK(attempt >= 1)、CHECK(0 <= recoveries <= max_recoveries)

run_steps    run_id text + seq int 复合 PK(run_id **FK → runs(id) ON DELETE CASCADE**)
             · kind text('step'|'wait'|'trigger-and-wait'|
             'batch-trigger'|'now'|'random'|'uuid',**CHECK**) · label text
             · status text('completed'|'failed',**CHECK**) · output jsonb · error jsonb
             · attempt int(**CHECK >= 1**) · started_at/finished_at timestamptz

queue        id bigserial PK · run_id text UNIQUE(**FK → runs(id) ON DELETE CASCADE**:
             删 run 即删它的排队行,手工 psql DELETE 也留不下 orphan queue)
             · available_at timestamptz · priority int DEFAULT 0
             · locked_by text · locked_at timestamptz · lease_until timestamptz · concurrency_key text
             (**`locked_by IS NULL` = 未被占用**;三列同进同出,claim 一起写、归还/reaper 一起清)
             索引 (available_at, priority desc) 与 (concurrency_key),外加两个部分索引,
             各自对应 §3.5 里一条一直在跑的扫描:
               queue_claimable_idx   (priority desc nulls first, id) WHERE locked_by IS NULL
                                     —— claim 的候选扫描(每个执行槽每轮都跑)
               queue_lease_until_idx (lease_until)       WHERE lease_until IS NOT NULL
                                     —— reaper 的过期租约扫描(每 10s)
             两个谓词都只覆盖各自那一小撮行(可领取的 / 在飞的),把积压里占绝大多数的
             「已 claim 且租约未到期」整个排除在索引之外

waits        id bigserial PK · run_id text(**FK → runs(id) ON DELETE CASCADE**)
             · step_seq int · kind text('duration'|'until'|'run',**CHECK**)
             · resume_at timestamptz · child_run_id text(**FK → runs(id) ON DELETE
             SET NULL**:被等待的子 run 被删时,wait 行保留、child_run_id 置 NULL,父
             run 由编排器 wait 扫描判失败(ChildLostError)—— CASCADE 会把父 run
             永久卡在 'waiting'(无 wait 无 queue,无路径恢复);prune 只删终态子
             run,其父 wait 早已被 wakeParentIfWaiting 解决,置 NULL 的只是历史指针)
             · status text('pending'|'completed'|'canceled',**CHECK**)
             · created_at timestamptz;索引 (status, resume_at) 与 (child_run_id)

logs         id bigserial PK · run_id text(**FK → runs(id) ON DELETE CASCADE**)
             · step_seq int · level text('debug'|'info'|'warn'|'error',**CHECK**) · message text
             · data jsonb · ts timestamptz;索引 (run_id, id)

schedules    id text PK ('sch_'+随机) · task_id text UNIQUE(**复合 FK
             (project_id, env, task_id) → tasks(project_id, env, id) ON DELETE CASCADE**:
             删 task 即删它的 cron 注册;syncSchedules 与 task upsert 同事务,不会造出
             没有 task 的 schedule) · cron_pattern text · cron_tz text
             · enabled boolean DEFAULT true · next_run_at timestamptz · last_run_at timestamptz
             · last_run_id text · created_at/updated_at

workers      id text PK ('wkr_'+随机) · name text · code_version text · runtime text
             · tasks jsonb(string[]) · concurrency int · started_at · last_heartbeat_at
             · status text('online'|'offline',**CHECK**)
             (**每次进程启动插一行新的**,下线只改 status —— 靠 §2.1 的保留策略清理)
```

以上 FK / CHECK 全部来自迁移 0011(C5,todos/01-correctness.md)。迁移先扫描并清理
orphan(不存在的 run/task 的 queue / waits 行直接删除,孤儿 `parent_run_id` 与
`waits.child_run_id` 置 NULL —— 与 FK 自身的 ON DELETE 行为一致),再加约束,所以带脏数据
的旧库也能自动迁移;之后**手工 DELETE 或非法状态写不进去**。注意两个 ON DELETE SET NULL
的语义:`runs.parent_run_id` 被置 NULL 的子 run 照常执行(只丢血缘指针);
`waits.child_run_id` 被置 NULL 的父 run 会被编排器的 wait 扫描以 `ChildLostError`
判失败(子 run 被删,结果永远不会来;不判失败父 run 会永远 'waiting' 卡死)。
CHECK 约束假定存量 status/kind/level 值已在合法集合内(引擎写出的值必然如此):若
库里有手工写入的非法值,0011 的 `ADD CONSTRAINT CHECK` 会失败并停掉所有 daemon 的
启动,此时需先手工修复该行(具体 UPDATE 语句见 0011 头部注释),迁移不会替你猜。
priority 没有 CHECK:应用层显式允许 int32 范围内任意值(负优先级合法,见 §3.5),与列类型一致即可。

### 2.1 数据保留(默认不删任何东西)

引擎自己不清理历史:`runs` / `run_steps` / `logs` 只增不减,`workers` 每次启动多一行。
两个显式的出口,**都要人主动开**:

- `better-trigger-worker prune --older-than 30d [--dry-run]` —— 一次性维护命令。删除
  在窗口之前进入终态(`completed`/`failed`/`canceled`)的 run,以及已 `offline` 且最后心跳
  早于窗口的 worker 行。非终态 run 无论多老都不删(卡住的 run 是要看的 bug,不是垃圾)。
  `--dry-run` 只报告、不执行任何 DELETE。
- `--retention 30d` —— 打开 daemon 里的低频 GC 循环(默认 1h 一次,`--gc-interval-ms` 可调),
  逻辑与 `prune` 完全同一份实现。**不给这个参数就没有这个循环**:默认行为不能是悄悄删用户数据。

`logs.run_id` / `run_steps.run_id` 上的 `ON DELETE CASCADE`(迁移 0007)是这件事的支点 ——
删 run 就是删它的日志和步骤账本,不需要第二份「删干净」的 SQL。迁移 0011(C5)把同一
支点扩展到了 `waits`(run 删 → 它的 wait 删;被等待的子 run 删 → 父的 wait 删)和
`queue`(run 删 → 排队行删),所以**任何**删除路径(prune、CLI、手工 psql)都留不下
orphan。prune 仍会在删 runs 之前手删一遍 queue 行 —— 这不是历史包袱,而是锁序:
queue 是规范锁序的 1 号位(见 §3.2),先拿它再拿 runs,才能避免级联从 runs 锁背后去
够 queue 行时与 reaper 互相等待。窗口有下限(60s):
`--older-than 0` 会删掉调用方正在 poll 结果的那个 run,直接拒绝而不是照做。

## 3. 引擎语义(不变量,重点读)

### 3.1 重放与位置键
- 每次执行 task 函数,SDK 维护一个**单调递增 seq 计数器**(从 0 开始),`ctx.step/wait/triggerAndWait/batchTrigger/now/random/uuid` **每调用一次消耗一个 seq**。
- claim 返回该 run 已完成 steps 快照(`claimRuns` 在同一事务里读 `run_steps`,见 §3.5);执行到 seq 时若快照中存在 `status='completed'` 的行 → **直接返回缓存 output,不执行 fn**。
- 快照中 `status='failed'` 的行视为未完成(重试时重新执行,结果 upsert 覆盖)。
- **漂移检查**:命中缓存前比对该行与调用点。`kind` 不一致(如 wait 行落到 `ctx.step()` 上)是硬信号——它由原语推导,不来自用户文本;`label` 不一致是软信号(改名无害,插入有害)。
  - `replay:'lenient'`(默认):`logger.warn` 一条 `replay drift at seq N: ...`,仍使用该缓存行。
  - `replay:'strict'`(task 级声明):抛 `AbortError` 终态失败,不重试(重试只会重放同一份错位账本)。含长 `ctx.wait` 的 task 建议开启——其账本可能跨越多次发版。

### 3.2 挂起(Suspend)
- `wait.for(d)` / `wait.until(date)`:SDK 先 `POST /runs/:id/suspend {seq, kind, resumeAt}`,成功后抛内部 `SuspendSignal`;执行器捕获后**静默结束本次执行**(不算失败),继续 poll 下一个 run。
- server 处理 suspend(单事务):插入 `waits` 行(pending)、`runs.status='waiting'`、删除该 run 的 queue 行。
- **到期恢复**(编排器 timer,每 1s 扫)分两阶段(C1):**阶段一**不持任何锁地读一批到期的 wait —— `waits WHERE status='pending' AND kind IN ('duration','until') AND resume_at <= now() ORDER BY resume_at ASC LIMIT 50`;**阶段二**每条 wait 各开一个短事务,按规范锁序 queue → runs → wait 依次上锁,并在锁下重新确认这条 wait 还是 `pending`(期间可能被取消,或被另一个 daemon 抢先恢复),然后标记 completed、写 `run_steps` 行(seq=step_seq, kind='wait', status='completed', output=null)、`runs.status='queued'`、插 queue 行(priority 从 `runs.priority` 读回,见 §2 的说明)。重放时该 seq 命中缓存 → 跳过。
  - 锁序里 runs 行与 wait 行都用 `SKIP LOCKED`:阶段一无锁,所以每个 daemon 读到的是同一批 wait,阻塞等待等于排队等同伴做完同一件事;跳过不会丢唤醒(行仍是 `pending` 且已过期,下一 tick 按 `resume_at` 排序又排在最前),也不会重复唤醒(runs 行是串行化点,只有一个实例能过)。queue 行那一位仍是阻塞式的 —— 理由见 `runs.ts` 头注释。**一个 wait 一个事务**,单事务的锁足迹因此只有一个 run,扫描之间不会交叉死锁。
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
- **`attempt` 只由本节的失败路径推进**:worker 消失走 `recoveries`(§3.5),优雅关停两本账都不动。用户看到 `attempt = 2` 就等于"我的代码失败过一次",与基础设施抖动无关。
- worker 上报任何接口若收到 `409 {code:'run_not_running'}`(run 已被 cancel 等)→ SDK 放弃该 run 的执行,不再上报。

### 3.5 队列与并发(SKIP LOCKED)

**claim 是一个事务**(`packages/kernel/src/queue.ts` 的 `claimRuns`,在 daemon 进程内直跑)。候选扫描一条 SQL 就把这一批要用的列全取回来:

```sql
SELECT q.id AS queue_id, q.run_id,
       r.task_id, r.payload, r.attempt, r.max_attempts,
       r.code_version, r.env, r.concurrency_key,
       t.concurrency_limit
  FROM queue q
  JOIN runs r ON r.id = q.run_id
  LEFT JOIN tasks t ON t.id = r.task_id
 WHERE q.available_at <= now() AND q.locked_by IS NULL
   AND r.task_id = ANY($1::text[])   -- 该 worker 注册的 task 集合
 ORDER BY q.priority DESC, q.id ASC
 LIMIT $2                            -- claimWindow(limit) = max(limit * 2, 10)
 FOR UPDATE OF q SKIP LOCKED
```

逐条读法:

- **`locked_by IS NULL` 是「未被占用」的唯一判据**(不是 `locked_at`)。`locked_by/locked_at/lease_until` 三列同进同出,所以**租约过期的行不是 claim 的候选** —— 它 `locked_by` 还在,回收只归 reaper 一家。两条路径的候选集因此不相交(`locked_by IS NULL` vs `lease_until` 有值),claim 永远不做接管。
- **task 过滤在 SQL 里**(`r.task_id = ANY($1::text[])`),不是取回来再在应用层丢掉:只注册了 2 个 task 的 worker,不会因为队头堆着别人的 run 就把整个候选窗口浪费掉。
- **版本钉死(`--pin-code-version`,默认关)**:开启后 `claimRuns` 多收一个与 `taskIds` **按位平行**的 `codeVersions`,task 过滤从「只按 id」换成「按 (id, version) 对」——

  ```sql
  WITH serving(task_id, code_version) AS (
    SELECT DISTINCT * FROM unnest($1::text[], $3::text[])
  )
  ... JOIN serving s ON s.task_id = r.task_id
   WHERE ... AND (r.code_version IS NULL OR r.code_version = s.code_version)
  ```

  为什么要有它:重放按位置寻址(§3.4),所以「run 在途时改了 run() 函数体」正是能让新代码撞上旧账本的那种改动;钉死把这个判断从执行器(它只能在已经重放到那一行时才发现)前移到 claim(根本不领)。同理**必须在 SQL 里过滤**,否则候选窗口会被别的版本的行占满,报「无活可干」而下一行明明可领。`code_version IS NULL` 仍然人人可领:那是 task 注册之前创建的 run,没有版本可尊重,也没有对着版本写过的账本。锁不变——CTE 是值列表不是可锁关系,`FOR UPDATE OF q` 依旧只锁 queue 行。
  **代价是对称的**:钉死意味着「宁可等,也不要用错代码跑」,所以旧版本再也不回来的 run 会**一直排队**。因此 orchestrator 多一条默认关闭的扫描(随 `--pin-code-version` 打开,30s 一次):找出 due 且未被占用、而 `code_version` 不被任何 online worker 提供的 run,按 (task, version) 分组落到 `better_trigger_stranded_runs` / `..._by_version`,并在画面变化时 warn 一次。「谁提供哪个版本」读的是 online worker 行的 `tasks` manifest。
- **窗口大小是参数化的 `claimWindow(limit) = max(limit * 2, 10)`**,不是写死的 10(PF3)。比 `limit` 宽,是因为候选被锁住之后仍可能被下面的并发限流跳过 —— 窗口正好等于 `limit` 时,队头挤着一批已达上限的 run 就会让这次 claim 空手而归,而下一行明明可领。也不能宽太多:窗口里每一行都被 `FOR UPDATE SKIP LOCKED` 按住整个事务,锁住却不领走 = 对其他 worker 隐身(它们 SKIP LOCKED 跳过)+ 削弱全局优先级序。`2x` 是能容忍跳过的最小倍数;下限 10 兜住最常见的 `limit: 1`。
- **`JOIN runs` + `LEFT JOIN tasks` 是为了消掉 N+1**(PF4):payload / attempt / max_attempts / code_version / env / concurrency_key / concurrency_limit 一次取回,而不是每个候选再发两条查询(窗口 10 行 = 一次 claim 20+ 条往返,而它通常只领走 1 个)。`JOIN runs` 是内连接:run 行已经不在的 queue 行直接不算候选。`LEFT JOIN tasks` 是外连接:没注册过的 task 表示「没有并发上限」,不是「不可领取」。
- **`FOR UPDATE OF q` 只锁 queue 行**,`runs` / `tasks` 只读不锁 —— 所以 claim 仍然只占规范锁序的第 1 位(queue),runs 行第一次被锁是下面那条 claim UPDATE(第 2 位)。在同一条语句里读 runs 的列是安全的:每一条改 run 的路径都先拿它的 queue 行 `FOR UPDATE`,所以与我们相争的事务要么正持有那个 queue 行(我们 SKIP LOCKED 跳过,根本看不见这一行),要么还没提交 —— 那它的 pre-image 里 `locked_by` 非空,过不了候选谓词。
- **索引**:`queue_claimable_idx (priority desc nulls first, id) WHERE locked_by IS NULL`(PF2)的键序就是这里的 ORDER BY、谓词就是这里的 `locked_by IS NULL`,扫到 LIMIT 就停,不必先排序再截断(`nulls first` 不是装饰:Postgres 里 DESC 默认就是 NULLS FIRST,空值序不一致的索引满足不了这个排序)。积压里绝大多数是已 claim 的行,而它们正是这条扫描以前要读出来再丢掉的;`available_at <= now()` 只能留作 filter(`now()` 不是 immutable,进不了部分索引的谓词)。

拿到候选后**在同一个事务里逐个处理**,领满 `limit` 就停(剩下的候选连看都不看,随 COMMIT 一起放开):

1. **并发限流**(仅当该 task 有 `concurrency_limit`;key = `runs.concurrency_key`,缺省 task_id):先取事务级 advisory lock `pg_advisory_xact_lock($classid, hashtext('bt:cc:' || key))`,`$classid = 0x62746363`(`'btcc'`,kernel 里的 `CONCURRENCY_LOCK_CLASS`)。用两参数版是为了把 better-trigger 的锁放进自己的命名空间,不与「共库的业务代码自己调 `pg_advisory_lock`」重叠,`pg_locks` 里也能一眼看出锁的主人(PF7)。这个锁是必需的:SKIP LOCKED 并不能让「两个 worker 各拿同一 key 的不同 queue 行」互相串行,先数后改会一起越过上限;锁随 COMMIT/ROLLBACK 释放,从不手动 unlock。
   然后 `SELECT count(*) FROM runs WHERE status='running' AND concurrency_key = $key`,`≥ limit` → **跳过这一行**(不改任何列,行留在队列里)。
   - 计数走 runs 而不是 join queue,**因此 runs 表也冗余存 `concurrency_key`**。默认 key = task_id;trigger options 可覆盖。
2. **领走**:`UPDATE queue SET locked_by=workerId, locked_at=now(), lease_until=now()+leaseMs`(queue 行,锁序第 1 位,已经在候选窗口里锁着),再 `UPDATE runs SET status='running', started_at=COALESCE(started_at, now()), fencing_token=fencing_token+1 RETURNING fencing_token`(runs 行,第 2 位)。**只有 claim 会推进 `fencing_token`**,返回的这个值就是本次 claim 的写入凭证,任何一次后来的 claim 都让它作废(fencing 语义见 architecture.md 与 `runs.ts` 头注释)。`attempt` / `recoveries` 都不动。
3. **读账本**:`SELECT seq, kind, label, status, output, error FROM run_steps WHERE run_id=$1 ORDER BY seq` —— 唯一保留的 per-run 查询(只有真正领到的 run 才需要它,而那是候选窗口里的一小撮)。
4. 循环结束 → COMMIT,每个领到的 run 交给执行器的是 `{ id, taskId, payload, attempt, maxAttempts, codeVersion, env, steps, fencingToken }`。

其余(租约、心跳、关停):

- **可见性超时** 60s(`lease_until = claim 时刻 + leaseMs`,靠心跳续期):reaper 每 10s 扫**最老的**一批过期租约 —— `WHERE lease_until IS NOT NULL AND lease_until <= now() ORDER BY lease_until ASC LIMIT 100 FOR UPDATE SKIP LOCKED`(键序与谓词都对着 `queue_lease_until_idx`;`LIMIT` 是刻意的:一批 daemon 同时挂掉时,单个事务不能锁住成百上千行把 claim 全挡在 SKIP LOCKED 外面,剩下的下一 tick 接着收 —— PF1)→ 释放锁(三列清空、`available_at=now()`)、**`recoveries+1`**、`runs.status='queued'`;若 `recoveries` 已达 `max_recoveries` → failed;run 行已经不在的 queue 行直接删掉。
- **两本预算分开记**(C4):`attempt/max_attempts` 是**用户代码**的失败预算(只有 failRun 会花),`recoveries/max_recoveries` 是**基础设施**接管预算(只有 reaper 会花,默认 10,`BETTER_TRIGGER_MAX_RECOVERIES` 在创建 run 时盖章)。worker 消失(部署、OOM、机器休眠)属于后者:`maxAttempts: 3` 的语义是"我的代码可以失败 3 次",三次部署不该把它耗光。因此 lease 过期的恢复**不动 `attempt`**,run 在**同一个 attempt** 上按账本继续重放;而 `max_recoveries` 仍然兜住"每个 claim 它的 worker 都会死"的无限循环。两种耗尽的终态错误文案必须可区分:reaper 写 `{ name: 'WorkerLostError', message: "worker lost: recovery budget exhausted (R/M infrastructure recoveries used; attempt A/N unaffected)" }`,用户代码耗尽 attempt 写的是用户自己的错误。`recoveries` 跨 attempt 累计,不重置。
- 心跳每 `leaseMs/3`(默认 60s 租约 → 20s,下限 500ms):带上在飞的 `runIds` → 把这些 run 的 **`queue.lease_until` 推到 `now() + leaseMs`**(`locked_at` 保持「什么时候被 claim 的」这个语义,**不刷新**),同时刷 worker `last_heartbeat_at`。续期语句本身 `RETURNING run_id`:续到的就是「我还持有的 claim」,请求集减去它、再减去 cancel 集就是 `lostRunIds`,不额外多一条查询。响应含 `cancelRunIds`(server 发现已 cancel 的 run)与 `lostRunIds`(请求续期但已不再持有 claim 的 run —— 被 reaper 收走或已终态)。两个集合互斥;收到 `lostRunIds` 的 executor 立刻 abort `ctx.signal`(reason `lease_lost`),不再为一份注定被 fencing 拒绝的结果空跑。worker 2 分钟无心跳 → 编排器标记 `offline`。
- **优雅关停**是主动交接,不是失败:daemon 排干后停掉心跳,把自己名下没排完的 claim 一次性归还(`locked_by/locked_at/lease_until = NULL`、`available_at = now()`、`runs.status='queued'`),并立刻把 workers 行标成 `offline`。**`attempt` 不递增**(一次部署不该花掉用户的重试预算),`fencing_token` 也不动 —— 释放 `locked_by` 已经让旧 executor 的迟到写立即被 `assertOwnedRunning` 拒掉,下一次 claim 的 token++ 再永久作废它们。因此正常重启的接管是秒级的,不用等可见性超时 + reaper。
- **领取节奏**:daemon 的每个并发槽各跑一条自己的 `claimRuns({ limit: 1 })` 循环 —— 领到就执行,执行完立刻再 claim;空手而归则按 300ms → 2s 指数退避(带 jitter),领到之后退避重置。所以最常见的形状就是 `limit=1`、候选窗口 10。没有 LISTEN/NOTIFY,因此「trigger → 开始执行」的冷启动延迟是 0–2s(量化见 `todos/02-performance.md` PF5;NOTIFY 在 architecture.md 的 P2)。

### 3.6 cron 调度
- worker register 时,manifest 带 cron 的 task → upsert `schedules`(保留已有 `enabled` 状态),用 **croner** 按 timezone 算 `next_run_at`。manifest 不再含 cron 的已有 schedule → 删除。
- 编排器每 1s:`schedules WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED` → 创建 run(trigger_type='schedule')+ 入队,更新 `last_run_at/last_run_id/next_run_at`(croner 算下一次)。
- 错过的窗口(server 宕机)不补跑,只从当前时间算下一次。

### 3.7 取消 / 手动重试
- `POST /api/v1/runs/:id/cancel`:queued/waiting/running → status='canceled', finished_at=now(),删 queue 行,waits 置 canceled;若它是某父的子 run → 父的 wait 以 `{ok:false, error:{message:'child canceled'}}` 回填并恢复父。running 状态下 worker 通过心跳响应 / 409 感知后放弃。
- `POST /api/v1/runs/:id/retry`:仅 failed/canceled;**创建新 run**(同 payload,trigger_type='retry',attempt=1,无缓存 steps),返回 `{runId}`。
  - **调度配置跟着走**(C7):`priority` 与 `concurrency_key` 从源 run 行复制到新 run(priority 读 `runs.priority` 这个冗余列 —— 源 run 已终态,queue 行早被删了)。否则从 dashboard 重试一个高优先级、单独限流的 run,重试出来的那个会掉回 priority 0、并挤进 task 默认的配额桶。
  - **`idempotency_key` 故意不跟着走**:复用它会撞上源 run 自己的部分唯一索引,`/retry` 会把「被重试的那个 run 的 id」原样还回来。`env` 跟着走,`attempt`/`recoveries` 从头计。

### 3.8 确定性替身
`ctx.now()` 返回 Date(首跑记 ISO 字符串,重放反序列化);`ctx.random()` 返回 number;`ctx.uuid()` 返回 string。三者都是 memoized 迷你 step(kind 对应),由 SDK 在**本地执行后异步上报**(与普通 step 相同上报接口,kind 不同)。

## 4. Worker 协议(全部 `/api/v1`,JSON,camelCase)

权威 TS 类型在 `packages/core/src/protocol.ts`。鉴权:`Authorization: Bearer <key>`(server 未配 key 时跳过校验)。

| 方法路径 | 请求体 → 响应 |
|---|---|
| `POST /workers/register` | `{ name?, codeVersion, runtime:'self-host', concurrency, tasks: TaskManifest[] }` → `{ workerId, heartbeatIntervalMs:15000, visibilityTimeoutMs:60000 }`。同时 upsert tasks 表 + schedules。**两级版本**:`codeVersion`(顶层)是 deploy 身份,只落 `workers.code_version`;`TaskManifest.codeVersion` 是 **per-task** 版本,落 `tasks.latest_code_version` → 进而 stamp 到该 task 之后每个 `runs.code_version`。两者都取 `BETTER_TRIGGER_VERSION`,否则由「task id + cron + **run 函数体源码指纹**」哈希得出(deploy 版本 hash 整个 task 集,task 版本只 hash 自己)——改实现即变版本(打包器/压缩器不同也会变;要稳定就显式设环境变量)。粒度是 per-task 而非 per-deploy 的原因见 3.5 的版本钉死:否则改一个 task 会把同进程里所有在途 run 一起钉死在旧版本上。`workers.tasks` 存 `[{id, codeVersion}]`(旧版本写的是 `["id"]`,读侧两种形状都认)。 |
| `POST /workers/:id/heartbeat` | `{ runIds: string[] }` → `{ ok:true, cancelRunIds: string[], lostRunIds: string[] }` |
| `GET /dequeue?workerId=&timeoutMs=` | → `{ run: null }` 或 `{ run: { id, taskId, payload, attempt, maxAttempts, codeVersion, env, steps: StepSnapshot[] } }` |
| `POST /runs/:id/steps` | `{ seq, kind, label, status:'completed'\|'failed', output?, error?, attempt, startedAt, finishedAt, workerId }` → `{ ok:true }`;run 非 running → 409 `{code:'run_not_running'}` |
| `POST /runs/:id/suspend` | `{ seq, label?, kind:'duration'\|'until', resumeAt, workerId }` → `{ ok:true, resumed:false }` 或 `{ ok:true, resumed:true }`(已到期,见 3.2) |
| `POST /runs/:id/wait-for-run` | `{ seq, label?, taskId, payload, options?, workerId }` → `{ childRunId }` |
| `POST /runs/:id/batch-trigger` | `{ seq, label?, items:[{taskId,payload,options?}], workerId }` → `{ runIds: string[] }`(server 创建 N 子 run + 写 step 行 kind='batch-trigger' output={runIds},**同事务幂等**:若 step 行已存在直接返回其 output) |
| `POST /runs/:id/complete` | `{ output, workerId }` → `{ ok:true }`(终态;若有父在等,回填并唤醒) |
| `POST /runs/:id/fail` | `{ error:{message,stack?,name?}, stepSeq?, retry?, abort?, workerId }` → `{ ok:true, willRetry:boolean, nextAttemptAt? }` |
| `POST /runs/:id/logs` | `{ logs: [{ts, level:'debug'\|'info'\|'warn'\|'error', message, data?, stepSeq?}] }` → `{ ok:true }`(尽力而为、不 fencing;run 不存在或已终态则静默写 0 行,不报错) |

`TaskManifest = { id, name?, filePath?, cron?: { pattern, timezone? }, retry?: RetryPolicy, concurrencyLimit?, description? }`

**触发 API(给应用代码 / dashboard)**:
- `POST /trigger` `{ taskId, payload, options?: { delay?: string|number(ms), idempotencyKey?, priority?, concurrencyKey?, env? } }` → `{ runId, idempotent: boolean }`(命中幂等键返回已有 run)。taskId 未注册 → 404。
- `POST /batch-trigger` `{ items: [{taskId, payload, options?}] }` → `{ runIds }`。`items` 超过 `BETTER_TRIGGER_MAX_BATCH`(默认 500)→ 400 `bad_request`;更大的扇出由调用方切成多次请求。

## 5. Dashboard API(`/api/v1`)

> 下面这些形状的权威 TS 定义在 `packages/core/src/types.ts`(Read models /
> Dashboard read models 两节)。`apps/worker/src/types.ts` 与 `apps/web/src/api/client.ts`
> 都只是同名 alias,不再各自手写一份。

- `GET /health` → `{ ok:true, version }`(存活探针,不碰 DB)
- `GET /health?deep=1` → `{ ok, version, db:{ ok, error? }, pool:{ total, idle, waiting } }`(就绪探针:`SELECT 1`,2s 超时;DB 不通 → 503。与浅层同路径以保持免鉴权;body 不含 pg 错误原文/主机名)
- `GET /tasks` → `{ tasks: [{ id, name, filePath, triggerSource, cronPattern, runs24h, p50Ms, p95Ms, successRate(0-100, 无运行=null), trend: number[12](近 24h 每 2h 运行数), lastRunAt }] }`(stats 用 `percentile_cont` 一次 SQL 聚合)
- `GET /runs?env=&taskId=&status=&limit=50&cursor=` → `{ runs: [{ id, taskId, status, trigger: trigger_type, codeVersion, env, attempt, durationMs(终态=finished-started; running=null), createdAt, startedAt, finishedAt }], nextCursor }`(按 created_at desc,cursor = 上页最后 run 的 created_at+id)
- `GET /runs/:id?logsBefore=` → `{ run:{...全字段含 payload/output/error}, steps:[run_steps 全字段], stepsTruncated, waits:[...], waitsTruncated, logs:[{id, stepSeq, level, message, data, ts}], logsNextCursor }`(PF3:run/steps/waits/logs 在**同一个 REPEATABLE READ 快照**里读,四部分永不同帧;logs 默认返回**最新 200 条、按 id 正序**(时间序),`logsNextCursor` = 本页最旧一条的 id,有更旧日志时非 null,把它作为 `?logsBefore=` 即翻到上一页,直到 cursor 为 null —— 1200 条日志的任务默认页能看到最后一条错误;steps/waits 各上限最新 500 条,截断时 `stepsTruncated`/`waitsTruncated` 置 true,完整分页是后续工作;`logsBefore` 非正整数 → 400)
- `POST /runs/:id/cancel` / `POST /runs/:id/retry`(见 3.7)
- `GET /schedules` → `{ schedules: [{ id, taskId, cronPattern, cronTz, enabled, nextRunAt, lastRunAt, lastRunStatus(查 last_run_id 的 status) }] }`
- `PATCH /schedules/:id` `{ enabled }` → 更新(enable 时重算 next_run_at)
- `GET /workers?status=online|offline|all&limit=50` → `{ workers: [{ id, name, codeVersion, runtime, tasks, concurrency, status, startedAt, lastHeartbeatAt }] }`(`workers` 是只增的历史表,见 §2.1:**默认只返回 online,且永远带 LIMIT**(默认 50,上限 200)。要看历史进程用 `status=offline` / `status=all`;未知的 `status` 是 `bad_request` 而不是「匹配不到」)
- `GET /metrics` → Prometheus 文本格式(`text/plain; version=0.0.4`),**不是 JSON**。指标名一律 `better_trigger_` 前缀:`db_up`、`queue_depth{state=available|scheduled|claimed}`、`inflight_runs`(全库 `runs.status='running'`)、`worker_inflight_runs`(本进程)、`runs_total{outcome=completed|failed|suspended|abandoned}`(**注意标签是 `outcome` 而不是 `status`**,见下)、`claim_errors_total` / `claim_errors_consecutive`、`heartbeat_errors_total` / `heartbeat_errors_consecutive`、`executor_errors_total`、`step_report_errors_total`、`fail_report_errors_total`、`log_flush_errors_total`、`reaper_recovered_total{outcome=requeued|failed}`、`orchestrator_errors_total{loop}`(`loop` 含 `gc`,即 §2.1 的保留循环 —— 没开 `--retention` 时恒为 0 而不是消失)。两个 SQL gauge 一次往返、2s 超时;DB 不通时**照样 200**,但 `db_up 0` 且省略 queue/inflight 两族(0 与「不知道」不能长得一样)。与 `/health` 不同,这个端点**跟着 `authMiddleware` 走**(设了 `BETTER_TRIGGER_API_KEY` 就需要 bearer):它暴露队列规模与吞吐,而 scraper 有地方放 token。

> `runs_total` 的 `outcome` 标签是 **Executor 对单次执行 pass 的判定,不是 `runs.status`**:`failed` 指这一次尝试被上报为失败(kernel 之后很可能还会重试),`suspended` 是 pass 停在了 wait 上(run 还活着),`abandoned` 是 lease 丢失后交还的 claim —— 后两个根本不是 `runs.status` 的取值。它同时是**按进程、按生命周期**计的:重启归零,换台 daemon 重试的 run 记在那一台上。要问「现在有多少 run 处于状态 X」请查 `runs` 表(或看 dashboard 的 `/tasks` 聚合);这里刻意不提供对应指标 —— 那是对无界历史做聚合而不是计数器,每次 scrape 都要扫表。

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
// 内部:register → N 个并发槽各自 claimRuns({limit:1})(300ms→2s 退避)→ 重放执行 → 心跳循环;
// SIGINT/SIGTERM 优雅退出(交还 claim + 标记 offline,见 §3.5)
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
