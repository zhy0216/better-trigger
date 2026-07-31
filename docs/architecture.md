# better-trigger 架构定案 — 客户端 / worker daemon 分离

> 状态:**已定案**(2026-07-29 用户拍板)。本文档是唯一基准。
> 形态:应用进程只装 `better-trigger`(定义 task + 通过 HTTP 触发,零运行时依赖、不碰 pg);
> 执行、队列、编排、HTTP API 全部收在 `better-trigger-worker` 这一个 daemon 里。
> **推翻**:2026-07-28 的「嵌入式 no-server(better-auth 形态)」定案(见 ADR 6)。
> `docs/backend-contract.md` 的 §3 引擎语义(位置 seq 重放、退避公式、并发限制、cron、suspend/resume 状态机)**继续有效**;§4 的 worker HTTP 协议依旧作废——worker 与 kernel 现在同进程,不存在 worker 协议。

## 一句话定位

一个 TypeScript-first、PostgreSQL-backed 的 durable execution runtime,面向**纯本地多 AI agent 系统**:跑一个本地 daemon(`better-trigger-worker --tasks ./src/tasks.ts`),它加载你的 task 模块、执行、并对外提供 HTTP;应用只用 `betterTrigger({ url })` 触发。Postgres 是唯一基础设施。

## 产品原则

1. **应用侧零负担**:`better-trigger` 只做两件事——`task()` 定义、`betterTrigger({url})` 触发。零运行时依赖,不打开数据库连接,可以安心 import 进 web server / CLI。
2. **API 维持 trigger.dev/Inngest 风格**:`task()` + inline `ctx.step()` + 直线 async(2026-06-05 用户选定)。不采用 Temporal 的 `defineWorkflow` / `proxyActivities` 表面。
3. **执行模型维持 step 记忆重放**(位置 seq + memoized 结果 + SuspendSignal),不重写为 event-history/command-matching;用 step fingerprint 硬化漂移检测。
4. **v1 绑定 PostgreSQL、不绑定用户 ORM**:runtime 自管 `better_trigger` system schema(drizzle 迁移,daemon 启动时 auto-migrate,`--no-migrate` 可关)。措辞:*PostgreSQL-backed and ORM-agnostic*,不说「数据库无关」。
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
  bunx --bun better-trigger-worker --tasks ./tasks.ts
```

```ts
// app.ts — 只触发,不执行,不连库
import { betterTrigger } from "better-trigger";
import { onboarding } from "./tasks";

betterTrigger({ url: "http://localhost:4848" }).setDefault();

const handle = await onboarding.trigger({ userId: "u1" }, { idempotencyKey: "u1" });
await handle.result();             // 服务端 long-poll 等待终态
```

**关键约束**:task 模块要被 daemon 独立 import,所以 `run` **不能闭包应用内部状态**(请求上下文、内存单例)。需要外部资源就在 `run` 里自行获取。

**进程模型**

- 单进程(默认):一个 daemon = 执行 + 编排 + API + dashboard。
- 多进程:N 个 daemon 共享 PG;task claim 与 timer/cron 扫描全部 `FOR UPDATE SKIP LOCKED`,天然多进程安全,**无 leader 选举**。`--no-serve` 得到纯执行节点,不带 `--tasks` 得到纯 API/dashboard 节点(只跑 lease reaper + worker 离线标记,**不跑 cron/waits/claim**)。
- 停机语义(诚实承诺):没有 daemon 在线时**只保存状态,不执行任何 timer/cron/step**;恢复后尽快继续。cron 错过的窗口不补跑。

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
| LLM / 工具调用 | 昂贵副作用:重放不重打(memoized);重试需幂等键,`ctx` 暴露 `idempotencyKey` / `attempt` |
| wait / timer | deadline 持久化;无 daemon 在线时不运行,恢复后尽快触发,只产生一次恢复 |
| daemon crash | lease 过期后由任意存活 daemon 接管;旧 lease 持有者的迟到写被 fencing token 拒绝 |
| 接管的代价 | 接管消耗 run 的 `recoveries`(上限 `max_recoveries`,默认 10),**不消耗 `attempt`** —— `maxAttempts` 是"我的代码可以失败几次",部署 / OOM / 机器休眠不该花它;优雅关停两本都不动。恢复在**同一个 attempt** 上按账本继续。`max_recoveries` 耗尽 → 终态 `worker lost`,错误文案里写明耗尽的是哪本预算 |
| step 间用户代码 | 必须确定性;fingerprint 不匹配 → `NonDeterminismError`(P2) |
| durable primitive 的异常 | **不要用 catch-all 包裹** `ctx.wait` / `ctx.step` / `triggerAndWait`:挂起与结束是靠抛异常传递的,吞掉它意味着 run 已经 `waiting`/终态而代码还在跑(副作用真发生、恢复后再发生一次)。捕获必须 `catch (err) { if (isControlFlowSignal(err)) throw err; ... }`(从 `better-trigger` 导出,同时认得挂起信号与结束信号;只判 `isSuspendSignal` 会漏掉 step 失败那条路径);运行时会在下一个 durable primitive 处以 `AbortError` + 一条 `warn` 日志抓住它 |
| task 模块 | 必须可被 daemon 独立 import;不得闭包应用内部状态 |
| PostgreSQL | v1 唯一生产存储;内部 repository 是模块边界,不是公开 adapter API |
| 所有 daemon 停止 | 只保存状态,不消耗任务("状态 durable,计算需要至少一个 daemon 在线") |
| 唤醒延迟 | v1 **全部靠轮询,没有推送**:trigger → 开始执行 ≤ 一个空闲退避周期(~2.4s)、`result()` 每个等待者 4 QPS、wait/cron 唤醒 50 次/秒。具体数字与出处见分阶段计划 P2 下的「轮询代价」;LISTEN/NOTIFY 排在 P2 |

## Schema

- `runs`:`fencing_token bigint`(**每 run 单调递增计数器**,claim 时 +1,一切写回校验;放在 runs 行而非 queue 行,使 queue 行被删除/重建(重试、resume)也不会重置 token)
- `runs`:`recoveries int` / `max_recoveries int`(reaper 接管计数,与 `attempt`/`max_attempts` 分开;创建时按 `BETTER_TRIGGER_MAX_RECOVERIES` 盖章,默认 10)
- `queue`:`lease_until`(持久 lease;queue 行只承载 lease,不承载 fencing 计数)
- `run_steps`:P2 增 `fingerprint text`(kind+label+inputHash;首跑写入,重放校验)
- `workers`:daemon 注册表(执行节点写心跳),供 dashboard 展示
- P3 新增:`events`(signal 语义:原子入库 + 唤醒,离线不丢,恰好消费一次)

## 包布局

```
apps/
  worker/           ← @better-trigger/worker:daemon(loader + executor + runtime +
                      orchestrator + Hono API),bin `better-trigger-worker`
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
**验收(已跑通,79 项;`bun run test:acceptance` 一键重跑,CI 每个 PR 都跑)**:e2e 18 项(hello / 多 step / wait 挂起恢复 / triggerAndWait / batchTrigger / 幂等键 / 重试与 AbortError / cron)· fencing 22 项 · replay-drift 17 项 · crash 14 项(3× SIGKILL,step 恰好一次)· worker-lost 8 项。场景全部跑在 `packages/testing` 的 harness 上,不变量断言(seq 连续只追加、终态冻结)由 harness 统一提供。

### P2 — 正确性硬化(1 周)
fingerprint + `NonDeterminismError`;vitest + 真 PG 的 correctness suite;crash / fault-injection harness(在每个持久化边界注入 throw / abort / 连接中断 / 重复投递);不变量断言(seq 连续只追加、终态不再接受写、每个外部事件至多一个 outcome、旧 fencing 全路径无效);LISTEN/NOTIFY 唤醒。

#### 轮询代价(LISTEN/NOTIFY 落地前的当前值)

四条唤醒路径全是轮询,没有推送。数字写在这里,免得要读代码才知道上限:

| 路径 | 当前值 | 代价 |
|---|---|---|
| trigger → 开始执行 | 空闲执行槽指数退避 300ms → 2s(`IDLE_POLL_BASE_MS` / `IDLE_POLL_MAX_MS`,`apps/worker/src/runtime.ts`),每次睡眠 ±20% jitter | 已空闲一阵的 daemon 上,冷启动延迟 0–2.4s(单槽中位 ~1s)。对「本地多 agent」这个定位是能被感知到的。并发槽各自独立退避、jitter 会打散相位,concurrency 越大实测中位越低,**上限不变**(仍是一个完整退避周期)。刚跑完一个 run 的槽退避重置为 300ms,所以繁忙时不吃这个延迟 |
| `handle.result()` / `GET /runs/:id/result` | 服务端每 `pollMs`(默认 250ms,查询参数可给 50–5000ms)一次 `SELECT status, output, error FROM runs`(`packages/kernel/src/runs.ts` 的 `waitForResult`) | 每个等待中的客户端 = **4 QPS 纯轮询**;M 个并发等待 = 4M QPS,100 个 fan-out 子任务就是 400 QPS,全打在 daemon 的同一个 pg pool(未配置时 `pg` 默认 max 10 连接)上。单跳服务端等待上限 30s(`MAX_RESULT_WAIT_MS`),客户端按自己的 deadline 每 25s 续一跳 |
| wait 到期唤醒 | `scanWaits` 每 tick `LIMIT 50`,tick 间隔 1s(`timerIntervalMs`) | **50 次唤醒/秒**,而且是**全局上限**:phase 1 是不加锁的普通读,每个 daemon 都读到同一批 50 行,再靠 `SKIP LOCKED` 互相跳过 —— 加 daemon 只增加争用,不提高吞吐。积压超过 50 时按 `resume_at` 升序逐 tick 消化 |
| cron 起 run | `scanCron` 每 tick `LIMIT 50`,tick 间隔 1s(`cronIntervalMs`) | 50 次调度/秒;这条的 phase 1 自带 `FOR UPDATE SKIP LOCKED`,每个 daemon 锁到互不相同的 50 行,所以**随 daemon 数线性放大**,不像 waits 那样是全局上限 |

两个扫描循环都有「上一 tick 没跑完就跳过本 tick」的护栏,所以 50/s 是 tick 能在 1s 内跑完时的上限;`scanWaits` 每条 wait 一个短事务,一个满 tick 就是 50 个 round-trip。

`NOTIFY` 落地后,前两行趋近于零,后两行变成「NOTIFY 唤醒 + 轮询兜底」。

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
| 「没 daemon 在线就没人调度」被误解 | README/文档使用承诺表原文;dashboard 显示「无在线 worker」警示 |
| daemon 与业务共库干扰 | 独立 `better_trigger` schema;建议独立数据库 |
| step 非幂等 + at-least-once → 副作用重复 | `ctx.idempotencyKey` 自动提供;文档强调;LLM 步骤给出幂等实践 |
| 确定性被违反 | fingerprint 硬检测 + eslint-plugin + `ctx.now/random/uuid`;VM sandbox 明确为远期(本地跑可信代码) |
| run_steps 无限增长(agent 长循环) | `continueAsNew` + 长度警告;不做 snapshot(与代码版本兼容复杂) |
| 代码升级致重放漂移 | 保留 code_version 锁定;远期 `ctx.patched()` |
| daemon 在 node 下无法 import `.ts` | 文档写明:bun/tsx 跑源码,或 `--tasks` 指向编译产物 |

## ADR 摘要

1. ~~**嵌入式 no-server(better-auth 形态)** — 2026-07-28 定案~~ → **已被 ADR 6 推翻**。
2. **step 记忆重放,而非 event-history/command-matching** — 已实现、语义够用;以 fingerprint + correctness suite 硬化,不重写。
3. **API 维持 task/step/wait(Inngest 风格)** — 2026-06-05 用户选定;不采纳 Temporal 表面(defineWorkflow/proxyActivities/WorkflowHandle)。
4. **PG-only v1** — 内部 repository 只是模块边界与测试 seam,不承诺公开 adapter;第二种数据库落地前不抽象。
5. **多 agent 是产品层** — 建立在 P3 signal/event 内核上;第一批仅 handoff/gather/requestApproval + ctx.llm。
6. **客户端 / worker daemon 分离** — 2026-07-29 定案,推翻 ADR 1。理由:应用进程不该为了触发一个任务而拿到数据库连接池和一整套执行循环;`pg` 也不该出现在一个「只想 `await hello.trigger()`」的包的依赖树里。代价是多一个进程和「task 模块必须可独立 import」的约束,两者都写进承诺表。
7. **进程级 registry(`Symbol.for`)承载 ALS** — 让 `better-trigger` 的重复副本不再破坏 `ctx` 检测;代价是一个全局符号,收益是去掉「必须恰好一份副本」这条隐性前提。
