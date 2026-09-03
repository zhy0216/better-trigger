# better-trigger 架构定案 — 客户端 / worker runtime 分离

> 状态:**已定案**(2026-07-29 用户拍板)。本文档是唯一基准。
> 默认形态:应用进程只装 `better-trigger`(定义 task + 通过 HTTP 触发,零运行时依赖、不碰 pg);
> 执行、队列、编排、HTTP API 全部收在 `better-trigger-worker` daemon 里。
> 2026-08-19 增加可选 embedded host:长驻 Node/Bun 应用可在本进程启动同一套 runtime,
> 不监听端口;daemon 仍是隔离与独立扩缩容的默认部署形态(见 ADR 8)。
> **推翻**:2026-07-28 的「嵌入式 no-server(better-auth 形态)」定案(见 ADR 6)。
> `docs/backend-contract.md` 的 §3 引擎语义(位置 seq 重放、退避公式、并发限制、cron、suspend/resume 状态机)**继续有效**;§4 的 worker HTTP 协议依旧作废——worker 与 kernel 现在同进程,不存在 worker 协议。

## 一句话定位

一个 TypeScript-first、PostgreSQL-backed 的 durable execution runtime,面向**纯本地多 AI agent 系统**:默认跑本地 daemon(`better-trigger-worker --tasks ./src/tasks.ts`),也可用 `createEmbeddedRuntime({tasks})` 把同一 runtime 放进长驻 Node/Bun 应用。Postgres 是唯一基础设施。

## 产品原则

1. **应用侧默认零负担**:`better-trigger` 只做两件事——`task()` 定义、`betterTrigger({url})` 触发。零运行时依赖,不打开数据库连接,可以安心 import 进 web server / CLI。需要单进程部署时,应用显式安装 `@better-trigger/worker` 并选择 embedded host,重依赖不会进入基础 SDK。
2. **API 维持 trigger.dev/Inngest 风格**:`task()` + inline `ctx.step()` + 直线 async(2026-06-05 用户选定)。不采用 Temporal 的 `defineWorkflow` / `proxyActivities` 表面。
3. **执行模型维持 step 记忆重放**(位置 seq + memoized 结果 + SuspendSignal),不重写为 event-history/command-matching;用 step fingerprint 硬化漂移检测。
4. **v1 绑定 PostgreSQL、不绑定用户 ORM**:runtime 自管 `better_trigger` system schema(drizzle 迁移,host 启动时 auto-migrate,daemon 用 `--no-migrate`、embedded 用 `migrate:false` 可关)。措辞:*PostgreSQL-backed and ORM-agnostic*,不说「数据库无关」。
5. **Dashboard 由 daemon 直接托管**,不是独立组件;agent 原语(P5)建立在 signal/event 内核(P3)之上。

## 形态速写

```ts
// tasks.ts — daemon 和你的 app 都 import 它
import { task } from "better-trigger";

export const onboarding = task({
  id: "user-onboarding",
  run: async (payload: { userId: string }, ctx) => {
    const u = await ctx.step("create-user", () => createUser(payload));
    await ctx.wait.for("24h");
    await ctx.step("send-tips", () => sendTips(u));
  },
});
```

```bash
# daemon:加载 tasks、迁移、执行、serve :4848
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

```ts
// app.ts — 只触发,不执行,不连库
import { betterTrigger } from "better-trigger";
import { onboarding } from "./tasks";

betterTrigger({ url: "http://localhost:4848" }).setDefault();

const handle = await onboarding.trigger({ userId: "u1" }, { idempotencyKey: "u1" });
await handle.result();             // 服务端 long-poll 等待终态
```

**daemon 模式关键约束**:task 模块要被 daemon 独立 import,所以 `run` **不能闭包应用内部状态**(请求上下文、内存单例)。embedded 直接接收 TaskHandle,可使用应用级依赖,但仍不能依赖重启后无法重建的 request-scoped/临时状态。

**进程模型**

- 单进程(默认):一个 daemon = 执行 + 编排 + API + dashboard。
- 单进程(embedded):宿主应用调用 `createEmbeddedRuntime({tasks})`;执行 + 编排在应用进程内运行,SDK 经 in-process fetch 复用同一套 Hono API,不监听 TCP 端口。一个进程只允许一个 embedded runtime。
- 多进程:N 个 daemon 共享 PG;task claim 与 timer/cron 扫描全部 `FOR UPDATE SKIP LOCKED`,天然多进程安全,**无 leader 选举**。`--no-serve` 得到纯执行节点,不带 `--tasks` 得到纯 API/dashboard 节点(只跑 lease reaper + worker 离线标记,**不跑 cron/waits/claim**)。
- 停机语义(诚实承诺):没有任何 worker runtime host 在线时**只保存状态,不执行任何 timer/cron/step**;恢复后尽快继续。cron 错过的窗口不补跑。

## 目标架构(分层)

```
应用进程
  better-trigger                     ← task() 定义 + betterTrigger({url}) HTTP 客户端
                                        零运行时依赖;不 import pg
      │  HTTP /api/v1
      ▼
better-trigger-worker(daemon)
  ├── task loader                    ← import --tasks 指向的模块,收集 TaskHandle
  ├── 执行运行时(runtime.ts)        ← register → N 个 claim 槽 → 重放执行 → 直写结果
  │     └── replay executor          ← 位置 seq 重放、step 记忆、SuspendSignal、fingerprint
  ├── orchestrator loops             ← timer 恢复 / cron / lease reaper / worker 离线,SKIP LOCKED
  └── Hono API                       ← trigger / batch-trigger / runs / schedules / workers / health
  @better-trigger/kernel             ← claim CTE + lease + fencing、retry/backoff、suspend/resume、
                                        cancel、并发限制(唯一 import pg 的库)
  @better-trigger/db                 ← drizzle schema + 迁移 + pool
```

`packages/core` 横跨两侧:共享类型、错误族(`KernelError` 的 code 在 HTTP 上原样往返)、duration/backoff 工具。**它必须保持零运行时依赖**——它在 SDK 的依赖路径上。

## 与 P1(嵌入式)的差异

| P1 嵌入式(2026-07-28) | 现在(daemon) |
|---|---|
| `betterTrigger({ database })` 在应用进程内建 kernel | `betterTrigger({ url })` 只是 HTTP 客户端 |
| `trigger.start({ tasks })` 在应用进程跑 claim 循环 | `better-trigger-worker --tasks <module>` 在 daemon 跑 |
| SDK 依赖 `pg` + `@better-trigger/db` | SDK 零运行时依赖 |
| `packages/core` 含 kernel(拖 pg/croner) | 拆出 `packages/kernel`;core 归零依赖 |
| `packages/server`(dashboard-only API) | `apps/worker`(执行 + 编排 + API 全在一起) |
| 执行器 + worker 循环在 `packages/sdk` | 移到 `apps/worker` |
| `handle.result()` 直接轮询 PG | `GET /runs/:id/result` 服务端 long-poll(≤30s/次,客户端按自己的 deadline 续) |

**保留不动**:runs/run_steps/waits/schedules/logs 表与状态机、退避公式(`computeBackoffMs`)、位置 seq 重放语义、`ctx` 全部表面(step/wait/logger/now/random/uuid)、幂等键、并发限制、croner 调度、lease + fencing token 语义、apps/web 与 adapter 层、REST 形状。

## 语义边界(承诺表)

| 能力 | 承诺 |
|---|---|
| Run 状态 | 由 payload、run_steps 记忆与确定性代码重建;不序列化调用栈 |
| step 结果记录 | 历史层 exactly-once(`(run_id, seq)` 唯一 + fencing) |
| step 执行(外部副作用) | **at-least-once**;不承诺通用 exactly-once |
| LLM / 工具调用 | 昂贵副作用:重放不重打(memoized);重试需幂等键(经 trigger `options.idempotencyKey` 传入);当前 attempt 见 `ctx.run.attempt` |
| wait / timer | deadline 持久化;无 daemon 在线时不运行,恢复后尽快触发,只产生一次恢复 |
| daemon crash | lease 过期后由任意存活 daemon 接管;旧 lease 持有者的迟到写被 fencing token 拒绝 |
| 接管的代价 | 接管消耗 run 的 `recoveries`(上限 `max_recoveries`,默认 10),**不消耗 `attempt`** —— `maxAttempts` 是"我的代码可以失败几次",部署 / OOM / 机器休眠不该花它;优雅关停两本都不动。恢复在**同一个 attempt** 上按账本继续。`max_recoveries` 耗尽 → 终态 `worker lost`,错误文案里写明耗尽的是哪本预算 |
| step 间用户代码 | 必须确定性;fingerprint 不匹配 → `NonDeterminismError`(P2) |
| durable primitive 的异常 | **不要用 catch-all 包裹** `ctx.wait` / `ctx.step` / `triggerAndWait`:挂起与结束是靠抛异常传递的,吞掉它意味着 run 已经 `waiting`/终态而代码还在跑(副作用真发生、恢复后再发生一次)。捕获必须 `catch (err) { if (isControlFlowSignal(err)) throw err; ... }`(从 `better-trigger` 导出,同时认得挂起信号与结束信号;只判 `isSuspendSignal` 会漏掉 step 失败那条路径);运行时会在下一个 durable primitive 处以 `AbortError` + 一条 `warn` 日志抓住它 |
| task 模块 | 必须可被 daemon 独立 import;不得闭包应用内部状态 |
| PostgreSQL | v1 唯一生产存储;内部 repository 是模块边界,不是公开 adapter API |
| 所有 daemon 停止 | 只保存状态,不消耗任务("状态 durable,计算需要至少一个 daemon 在线") |
| 唤醒延迟 | trigger → claim 与 result 等待两条路径已由 **LISTEN/NOTIFY 快速路径**覆盖(`work` 通知唤醒空闲 claim 退避,`terminal` 通知立即结算等待者;轮询保留为兜底)。**wait 到期与 cron 唤醒仍是纯轮询**(50 次/秒的全局/线性上限,且没有推送源可去掉);数字与出处见分阶段计划 P2 下的「轮询代价」 |

## Schema

- `runs`:`fencing_token bigint`(**每 run 单调递增计数器**,claim 时 +1,一切写回校验;放在 runs 行而非 queue 行,使 queue 行被删除/重建(重试、resume)也不会重置 token)
- `runs`:`recoveries int` / `max_recoveries int`(reaper 接管计数,与 `attempt`/`max_attempts` 分开;创建时按 `BETTER_TRIGGER_MAX_RECOVERIES` 盖章,默认 10)
- `queue`:`lease_until`(持久 lease;queue 行只承载 lease,不承载 fencing 计数)
- `run_steps`:P2 增 `fingerprint text`(kind+label+inputHash;首跑写入,重放校验)
- `workers`:daemon 注册表(执行节点写心跳),供 dashboard 展示
- P3 新增:`events`(signal 语义:原子入库 + 唤醒,离线不丢,恰好消费一次)

## 时钟契约(05-T1)

**一切调度判定都用数据库时钟**(pg 的 `now()`):claim 扫描 `available_at <= now()`、wait 扫描 `resume_at <= now()`、cron 的 `next_run_at <= now()`、lease 的 `lease_until <= now()`。因此**凡是「从现在起多久之后可用/到期」的写入,时间戳必须盖数据库时钟,而不是 daemon 的宿主时钟**——否则宿主钟相对 DB 超前多少,这条记录就对扫描器隐身多久。

具体规则:

- **相对时刻(延迟/退避/时长)→ 数据库时钟 + 偏移**。内核在自己的事务里读一次 `now()`(pg 的 `now()` 即事务开始时刻,与判定方用的是同一个值),再加偏移:
  - 新 run 的 `available_at`(trigger/batch/cron 触发的入队、`options.delay`);
  - 失败重试的 `available_at`(`failRun` 退避);
  - wait 到期恢复与父唤醒后的重新入队(「现在即可用」= 数据库的 `now()`);
  - `wait.for(d)` 挂起:executor 传来的 `resumeAt` 是宿主钟算的绝对值,内核把它折算成**剩余时长**(`resumeAt − 宿主 now()`)再锚到数据库时钟上存 `resume_at`——宿主钟偏斜只会影响「折算瞬间」的取值,不会把整个偏斜量带进存储。
- **绝对时刻(`wait.until`)→ 原样尊重**。调用方指定的是一个确定的时间点,不需要(也不应该)重新锚定,直接存。
- **cron 的下次触发** 同样按数据库时钟计算,并被钳到 `now() + 1s` 之后(见 p1-09),偏斜的宿主钟不可能让同一 schedule 连续两次触发。

宿主时钟唯一合法的出现处:纯展示/信息性字段(如 `failRun` 返回的 `nextAttemptAt`),以及「已到期就同步恢复」这类只在宿主进程内比较的快路径——它们不参与数据库判定。判定与写入同钟,是「触发后立即可见、延迟恰好是延迟」的前提;`packages/kernel/test/pg/clock-skew.test.ts` 把宿主钟拨快 5 分钟,逐条钉住上述路径。

## 包布局

```
apps/
  worker/           ← @better-trigger/worker:daemon(loader + executor + runtime +
                      orchestrator + Hono API),bin `better-trigger-worker`,
                      subpath `@better-trigger/worker/embedded`
  web/              ← dashboard(Vite + React)
packages/
  sdk/              ← better-trigger:task() + ctx 类型 + HTTP 客户端。零运行时依赖
                      `better-trigger/internal` 是给 daemon 的内部缝(ALS + 定义适配器),非公开 API
  core/             ← 共享类型 / 错误族 / duration / backoff。**零运行时依赖(硬约束)**
  kernel/           ← @better-trigger/kernel:PG 引擎(内部包)
  db/               ← drizzle schema / 迁移 / pool
  testing/          ← P2/P3:虚拟时间、crash harness、correctness suite
  eslint-plugin/    ← P6:确定性 lint 规则
```

### 一个实现细节:进程级 registry

`ctx` 检测(「我是不是在 run 里?」)靠 `AsyncLocalStorage`。daemon 与用户 task 模块可能解析到**两份** `better-trigger`(不同 node_modules 树、bundle 与 link 并存),模块作用域的 ALS 会因此失效,表现为 `triggerAndWait()` 在 run 内抛「must be called inside a running task」。

所以 ALS、默认客户端、`RunHandle.result()` 的 resolver 三者都挂在 `globalThis[Symbol.for('better-trigger.registry.v1')]` 上(`packages/sdk/src/registry.ts`)。副本再多也共享同一份。

## 分阶段计划

### P1 — 内核落地(已完成)
claim CTE + `FOR UPDATE SKIP LOCKED`、持久 lease、单调 fencing token、orchestrator 循环、重放执行器。

### P1.5 — 客户端/daemon 分离(已完成,本文档)
core 拆分(kernel 独立成包、core 归零依赖);`packages/server` → `apps/worker`;执行器与 worker 循环移入 daemon;SDK 改写为 HTTP 客户端;`--tasks` 加载器 + CLI(`--port/--concurrency/--lease-ms/--no-serve/--no-migrate/...`);`GET /runs/:id/record`、`GET /runs/:id/result` long-poll。
**验收(已跑通,9 个 harness;`bun run test:acceptance` 一键重跑,CI 每个 PR 都跑)**:e2e 18 项(hello / 多 step / wait 挂起恢复 / triggerAndWait / batchTrigger / 幂等键 / 重试与 AbortError / cron)· fencing 24 项 · replay-drift 17 项 · code-version-pinning 11 项(同一次改动,钉死开与关的两面)· concurrency 9 项 · crash 14 项(3× SIGKILL,step 恰好一次)· worker-lost 10 项 · graceful-restart 10 项 · retention 5 项。场景全部跑在 `packages/testing` 的 harness 上,不变量断言(seq 连续只追加、终态冻结)由 harness 统一提供。

### P2 — 正确性硬化(1 周)
fingerprint + `NonDeterminismError`;vitest + 真 PG 的 correctness suite(已交付:`packages/kernel/test/pg/`,DATABASE_URL 门控,随 `bun run test` 跑,CI 的 postgres service 直接覆盖——见 p1-22);crash / fault-injection harness(**未交付**,仍在 P2:在每个持久化边界注入 throw / abort / 连接中断 / 重复投递);不变量断言(seq 连续只追加、终态不再接受写、每个外部事件至多一个 outcome、旧 fencing 全路径无效);LISTEN/NOTIFY 唤醒(**已交付**,覆盖 trigger→claim 与 result 等待两条路径:发送端 `packages/kernel/src/notify.ts`(事务末句 `pg_notify`,COMMIT 才投递),接收端 `apps/worker/src/notify.ts`(每 daemon 一条专用 LISTEN 连接)+ `apps/worker/src/runtime.ts` 的 `sleepWithWake` 空闲唤醒 + `apps/worker/src/waiters.ts` 的等待者注册表;真 PG 延迟证据 `packages/kernel/test/pg/suspend-notify.test.ts`。**wait 到期与 cron 唤醒仍是纯轮询**——扫描循环本身没有可订阅的事件源,通知只在「变成可 claim」的那一刻加速下游)。

#### 轮询代价(NOTIFY 落地后的现状:快速路径 + 轮询兜底)

四条唤醒路径中,前两条有推送快速路径,轮询退化为「通知丢失/连接断开时最多一个周期」的兜底;后两条仍是纯轮询。数字写在这里,免得要读代码才知道上限:

| 路径 | 当前值 | 代价 |
|---|---|---|
| trigger → 开始执行 | `work` 通知在 enqueue 事务 COMMIT 时发出(`notifyWork`),唤醒空闲执行槽的退避睡眠(`sleepWithWake`,300ms → 2s 退避仍是兜底,`apps/worker/src/runtime.ts`) | 通知到达时冷启动延迟 ~0(一次 COMMIT→wake 的往返);LISTEN 连接断开或通知丢失时退回旧上界 0–2.4s。并发槽各自独立退避、jitter 会打散相位;刚跑完一个 run 的槽退避重置为 300ms,所以繁忙时本来就不吃这个延迟 |
| `handle.result()` / `GET /runs/:id/result` | `terminal` 通知立即结算该 run 的全部等待者(`apps/worker/src/waiters.ts` 注册表);注册表自带的共享扫描是**每进程 1 QPS 一条 `WHERE id = ANY(...)`** 的兜底,不再是每等待者 4 QPS | 通知路径下每等待者 ~0 查询;兜底路径下 M 个并发等待合计 ≈1 QPS(旧值 4M QPS 的反面)。单跳服务端等待上限 30s(`MAX_RESULT_WAIT_MS`)不变,客户端按自己的 deadline 每 25s 续一跳 |
| wait 到期唤醒 | `scanWaits` 每 tick `LIMIT 50`,tick 间隔 1s(`timerIntervalMs`) | **50 次唤醒/秒**,而且是**全局上限**:phase 1 是不加锁的普通读,每个 daemon 都读到同一批 50 行,再靠 `SKIP LOCKED` 互相跳过 —— 加 daemon 只增加争用,不提高吞吐。积压超过 50 时按 `resume_at` 升序逐 tick 消化。到期后重新入队会发 `work` 通知,所以下游 claim 是快的;慢的是「发现到期」这一步本身,没有推送源 |
| cron 起 run | `scanCron` 每 tick `LIMIT 50`,tick 间隔 1s(`cronIntervalMs`) | 50 次调度/秒;这条的 phase 1 自带 `FOR UPDATE SKIP LOCKED`,每个 daemon 锁到互不相同的 50 行,所以**随 daemon 数线性放大**,不像 waits 那样是全局上限。起 run 后的 enqueue 走 `work` 通知,同样只是下游变快,「发现到点」仍是纯轮询 |

两个扫描循环都有「上一 tick 没跑完就跳过本 tick」的护栏,所以 50/s 是 tick 能在 1s 内跑完时的上限;`scanWaits` 每条 wait 一个短事务,一个满 tick 就是 50 个 round-trip。

NOTIFY 只是延迟优化,从不承载正确性:每条路径的轮询兜底都保留着,丢一条通知最多慢一个轮询周期。

### P3 — 交互原语(1–2 周)
`event()` / `emit` / `wait.forEvent`(signal 级不变量:写入与唤醒原子、离线不丢、恰好消费一次);cancel 级联(父→子传播);`batchTriggerAndWait`(fan-out/fan-in);testing 包虚拟时间(测试里跳过数天 wait)。

### P4 — Dashboard / CLI(0.5–1 周)
daemon 托管 web 构建产物(`better-trigger-worker` 直接给出可用 dashboard,不再需要单独跑 vite);手动触发/重试/取消已在 REST 上;`better-trigger-worker migrate` 子命令。

### P5 — Agent 层 MVP(2–3 周)
第一批**只做 3 个连接点 + 1 个步骤类型**(吸取 2026-06-06 废弃草案「9 原语没立住」的教训):
- `ctx.handoff`(受控移交)
- `ctx.gather`(fan-out/fan-in,基于 batchTriggerAndWait)
- `ctx.requestApproval`(human-in-the-loop,基于 wait.forEvent)
- `ctx.llm`(memoized LLM 步骤:记录 model/params/usage,重放不重打)
- `continueAsNew`(agent 长循环防 run_steps 无限增长)
- dashboard agent 视图(handoff/会话图);examples/multi-agent。

### P6 — 打磨(持续)
plugin interceptors 全量(client/step/worker/persistence 四类)、eslint-plugin、query(观察运行中状态)、鉴权超出单一 Bearer key。

## 北极星 demo(P5 验收)

planner fan-out 3 个 researcher → `gather` 汇总 → `requestApproval` 人工审批 → writer 产出;在任意边界 `kill -9` daemon;重启后 **LLM 调用不重复计费、审批不丢、历史无重复 step、结果正确**。

## 风险

| 风险 | 应对 |
|---|---|
| task 模块必须可独立 import(不能闭包 app 状态) | 文档写在承诺表里;loader 报错信息明确;示例全部按此写 |
| 多一个进程要运维 | 单命令启动、auto-migrate、`--no-serve`/无 `--tasks` 覆盖多节点形态;docker-compose 直接给出 |
| embedded 与业务共享事件循环/内存/连接预算 | embedded 是显式 opt-in;共享 pool 时由宿主定容量,需要故障隔离或独立扩缩容时使用 daemon |
| embedded 被误解为“无需在线 worker” | 文档明确:它只去掉独立 OS 进程;宿主停止时状态仍 durable,但 task/timer/cron 不执行 |
| 「没有 runtime host 在线仍会调度」的误解 | README/文档使用承诺表原文;dashboard 显示「无在线 worker」警示 |
| daemon 与业务共库干扰 | 独立 `better_trigger` schema;建议独立数据库 |
| step 非幂等 + at-least-once → 副作用重复 | 幂等键由调用方在 trigger `options.idempotencyKey` 提供;文档强调;LLM 步骤给出幂等实践 |
| 确定性被违反 | fingerprint 硬检测 + eslint-plugin + `ctx.now/random/uuid`;VM sandbox 明确为远期(本地跑可信代码) |
| run_steps 无限增长(agent 长循环) | `continueAsNew` + 长度警告;不做 snapshot(与代码版本兼容复杂) |
| 代码升级致重放漂移 | per-task code_version + `--pin-code-version`(claim 只领本进程能重放的版本,孤儿 run 有 metric 兜底);远期 `ctx.patched()` |
| daemon 在 node 下无法 import `.ts` | 文档写明:bun/tsx 跑源码,或 `--tasks` 指向编译产物 |

## ADR 摘要

1. ~~**嵌入式 no-server(better-auth 形态)** — 2026-07-28 定案~~ → **已被 ADR 6 推翻**。
2. **step 记忆重放,而非 event-history/command-matching** — 已实现、语义够用;以 fingerprint + correctness suite 硬化,不重写。
3. **API 维持 task/step/wait(Inngest 风格)** — 2026-06-05 用户选定;不采纳 Temporal 表面(defineWorkflow/proxyActivities/WorkflowHandle)。
4. **PG-only v1** — 内部 repository 只是模块边界与测试 seam,不承诺公开 adapter;第二种数据库落地前不抽象。
5. **多 agent 是产品层** — 建立在 P3 signal/event 内核上;第一批仅 handoff/gather/requestApproval + ctx.llm。
6. **客户端 / worker daemon 分离** — 2026-07-29 定案,推翻 ADR 1。理由:应用进程不该为了触发一个任务而拿到数据库连接池和一整套执行循环;`pg` 也不该出现在一个「只想 `await hello.trigger()`」的包的依赖树里。代价是多一个进程和「task 模块必须可独立 import」的约束,两者都写进承诺表。
7. **进程级 registry(`Symbol.for`)承载 ALS** — 让 `better-trigger` 的重复副本不再破坏 `ctx` 检测;代价是一个全局符号,收益是去掉「必须恰好一份副本」这条隐性前提。
8. **daemon 默认 + embedded 可选 host** — 2026-08-19 定案。不回退 ADR 6 的包边界:`better-trigger` 继续零依赖、只认 HTTP 语义;`@better-trigger/worker/embedded` 显式把 pg/kernel/runtime 带进长驻 Node/Bun 宿主,并用 in-process fetch 复用 Hono 路由。这样“不跑独立 daemon”是部署选择,不是第二套 client/kernel 语义。代价是应用与 task 共享故障域,且所有宿主停止时仍无人执行 durable 状态。
