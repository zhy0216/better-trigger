# better-trigger v2 架构定案 — 嵌入式运行时(better-auth 形态)

> 状态:**已定案**(2026-07-28 用户拍板嵌入式)。本文档定义 v2 目标架构与迁移计划。
> 当前代码(M1+M2)仍是 `docs/backend-contract.md` 描述的 server 形态;P1 落地后以本文档为唯一基准。
> contract 中与传输协议无关的引擎语义(位置 seq 重放、退避公式、并发限制、cron、suspend/resume 状态机)**继续有效**。
> 来源:2026-07-28 架构笔记(gitmemo-r/notes/manual/better-trigger架构与实施计划.md)中采纳其嵌入式哲学与正确性/测试策略;不采纳其 Temporal API 表面与 event-history 执行模型。

## 一句话定位

一个 TypeScript-first、**嵌入应用进程**、PostgreSQL-backed 的 durable execution runtime,面向**纯本地多 AI agent 系统**:像 Better Auth 一样 `betterTrigger(options)` 一次配置得到完整实例,无独立 orchestration server;`pg` 是唯一硬依赖。

## 产品原则

1. **像 Better Auth 一样嵌入和配置**:单一入口、小核心、强类型、plugin 扩展;不要求任何额外进程。
2. **API 维持 trigger.dev/Inngest 风格**:`task()` + inline `ctx.step()` + 直线 async(2026-06-05 用户选定)。不采用 Temporal 的 `defineWorkflow` / `proxyActivities` 表面;`task('id')` 已满足「稳定名称」要求。
3. **执行模型维持 step 记忆重放**(位置 seq + memoized 结果 + SuspendSignal),不重写为 event-history/command-matching;用 step fingerprint 硬化漂移检测。
4. **v1 绑定 PostgreSQL、不绑定用户 ORM**:runtime 自管 `better_trigger` system schema(drizzle 迁移,init 时 auto-migrate,可关)。文档措辞:*PostgreSQL-backed and ORM-agnostic*,不说「数据库无关」。
5. **Studio(dashboard)是可选工具进程**,不是架构组成部分;agent 原语(P5)建立在 signal/event 内核(P3)之上。

## 形态速写

```ts
// trigger.ts — 应用里唯一的配置点
import { betterTrigger } from "better-trigger";
import { Pool } from "pg";

export const trigger = betterTrigger({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  migrations: "auto",              // init 时自动迁移 system schema;可 "manual"
  plugins: [],
});

// tasks.ts — API 不变
export const onboarding = task({
  id: "user-onboarding",
  run: async (payload: { userId: string }, ctx) => {
    const u = await ctx.step("create-user", () => createUser(payload));
    await ctx.wait.for("24h");
    await ctx.step("send-tips", () => sendTips(u));
  },
});

// 应用进程内启动执行(应用进程就是 worker)
await trigger.start({ tasks: [onboarding], concurrency: 5 });

// 触发:直接走 PG,无 HTTP
const handle = await onboarding.trigger({ userId: "u1" }, { idempotencyKey: "u1" });
await handle.result();             // 轮询/NOTIFY 等待终态

// 专用 worker 进程 = 另一个进程跑同一段配置(同一个库、同一个 PG),不是另一种组件
// Studio(可选):bunx better-trigger studio → 本地 dashboard,连同一个 PG
```

**进程模型**

- 单进程:app 内嵌 client + worker + orchestrator 循环,零额外进程。
- 多进程:N 个进程各自内嵌、共享 PG;task claim 与 timer/cron 扫描全部 `FOR UPDATE SKIP LOCKED`,天然多进程安全,**无 leader 选举**。
- 停机语义(诚实承诺):所有进程停止时**只保存状态,不执行任何 timer/cron/step**;恢复后尽快继续。cron 错过的窗口不补跑(与现契约一致)。

## 目标架构(分层)

```
App process
  betterTrigger(config)              ← facade:校验连接/auto-migrate/注册 plugins
    ├── runs client(trigger / batchTrigger / handle.result / cancel / retry)
    ├── in-process worker(claim → 重放执行 → 直写结果)
    ├── orchestrator loops(timer 恢复 / cron / lease reaper,SKIP LOCKED)
    └── plugins / interceptors(P6 全量)
  Task runtime(executor)            ← 位置 seq 重放、step 记忆、SuspendSignal、fingerprint
  Durable kernel(packages/core)    ← claim CTE + lease + fencing、retry/backoff、
                                       suspend/resume、cancel、并发限制、LISTEN/NOTIFY 唤醒(轮询保底)
  Persistence(packages/db)         ← drizzle schema + 迁移 + pool(不变)
```

## 与 M1+M2 的差异(P1 执行清单)

| 现在(server 形态) | v2(嵌入式) |
|---|---|
| worker HTTP long-poll `GET /dequeue` | 直接 PG claim:短事务 CTE + `FOR UPDATE SKIP LOCKED` |
| step/suspend/complete/fail 走 HTTP 上报 | kernel 方法直写(与状态迁移同事务) |
| visibility timeout + `locked_by` | 持久 lease(`lease_until`)+ 单调 **fencing token**;所有完成路径校验 token |
| server 内 orchestrator 单点循环 | 每个实例内嵌循环,SKIP LOCKED 多进程安全 |
| `core/src/protocol.ts` HTTP 协议类型 | 删除 |
| `sdk/src/client.ts` + long-poll worker | 删除,worker 改为直连 claim 循环 |
| `configure({ apiUrl, apiKey })` | 由实例绑定取代(task 定义保持 instance-free,触发经默认实例) |
| `packages/server` | 降级改造为 `packages/studio`(可选 dashboard 工具,复用现有 REST 形状与 apps/web) |
| 500ms 内部轮询 | LISTEN/NOTIFY 降低唤醒延迟,轮询保底(NOTIFY 不是 durable queue) |

**保留不动**:runs/run_steps/waits/schedules/logs 表与状态机、退避公式(`computeBackoffMs`)、位置 seq 重放语义、`ctx` 全部表面(step/wait/logger/now/random/uuid)、幂等键、并发限制、croner 调度、apps/web 与 adapter 层。

## 语义边界(承诺表)

| 能力 | 承诺 |
|---|---|
| Run 状态 | 由 payload、run_steps 记忆与确定性代码重建;不序列化调用栈 |
| step 结果记录 | 历史层 exactly-once(`(run_id, seq)` 唯一 + fencing) |
| step 执行(外部副作用) | **at-least-once**;不承诺通用 exactly-once |
| LLM / 工具调用 | 昂贵副作用:重放不重打(memoized);重试需幂等键,`ctx` 暴露 `idempotencyKey` / `attempt` |
| wait / timer | deadline 持久化;无进程在线时不运行,恢复后尽快触发,只产生一次恢复 |
| 进程 crash | lease 过期后由任意存活进程接管;旧 lease 持有者的迟到写被 fencing token 拒绝 |
| step 间用户代码 | 必须确定性;fingerprint 不匹配 → `NonDeterminismError`(不再只 warn) |
| PostgreSQL | v1 唯一生产存储;内部 repository 是模块边界,不是公开 adapter API |
| 所有进程停止 | 只保存状态,不消耗任务("状态 durable,计算需要至少一个进程在线") |

## Schema 增量

- `queue`:+ `fencing_token bigint`(claim 时 +1;一切写回校验)、`lease_until`(替代 locked_at+固定超时语义)
- `run_steps`:+ `fingerprint text`(kind+label+inputHash;首跑写入,重放校验)
- `workers`:语义改为「进程注册表」(嵌入实例直接写心跳),仅供 studio 展示
- P3 新增:`events`(signal 语义:原子入库 + 唤醒,离线不丢,恰好消费一次)
- 其余表不变

## 包布局

```
packages/
  better-trigger/   ← 现 sdk 更名/吸收:facade + task + ctx + executor + in-process worker + client
  core/             ← 从「纯类型」升级为 durable kernel(吸收 server/src/engine/*);内部包
  db/               ← 不变:drizzle schema / 迁移 / pool
  studio/           ← 现 server 降级改造:dashboard REST(形状不变)+ 托管 web 构建产物;可选安装
  testing/          ← P2/P3:虚拟时间、crash harness、correctness suite
  eslint-plugin/    ← P6:确定性 lint 规则
apps/web            ← 不变(adapter 已隔离 REST 形状)
```

## 分阶段计划

### P0 — 定案与清场(0.5 天)
本文档;提交 dashboard 接线改动;README/PRD 定位改写(PRD §11 SaaS/gVisor/M4 标记废弃)。

### P1 — 内核内嵌(1–1.5 周)
「与 M1+M2 的差异」清单全部落地;examples/basic 改嵌入式(单文件可跑)。
**验收**:零 HTTP 进程跑通现 e2e 全部场景(hello / 多 step / wait 挂起恢复 / triggerAndWait / batchTrigger / 幂等键 / 重试与 AbortError / cron);任意时刻 `kill -9` 进程,重启后恢复且无重复 step 行;人为拖延旧持有者后其迟到写被 fencing 拒绝。

### P2 — 正确性硬化(1 周)
fingerprint + `NonDeterminismError`;vitest + 真 PG 的 correctness suite;crash / fault-injection harness(在每个持久化边界注入 throw / abort / 连接中断 / 重复投递);不变量断言(seq 连续只追加、终态不再接受写、每个外部事件至多一个 outcome、旧 fencing 全路径无效);LISTEN/NOTIFY 唤醒。
**验收**:移植 2026-07-28 笔记 Phase 2 验收条款。

### P3 — 交互原语(1–2 周)
`event()` / `emit` / `wait.forEvent`(signal 级不变量:写入与唤醒原子、离线不丢、恰好消费一次);cancel 级联(父→子传播);`batchTriggerAndWait`(fan-out/fan-in);testing 包虚拟时间(测试里跳过数天 wait)。

### P4 — Studio(0.5–1 周)
server → studio 改造:`bunx better-trigger studio` 起本地 dashboard;手动触发/重试/取消直调内嵌实例;apps/web 零改动或微调。

### P5 — Agent 层 MVP(2–3 周)
第一批**只做 3 个连接点 + 1 个步骤类型**(吸取 2026-06-06 废弃草案「9 原语没立住」的教训):
- `ctx.handoff`(受控移交)
- `ctx.gather`(fan-out/fan-in,基于 batchTriggerAndWait)
- `ctx.requestApproval`(human-in-the-loop,基于 wait.forEvent)
- `ctx.llm`(memoized LLM 步骤:记录 model/params/usage,重放不重打)
- `continueAsNew`(agent 长循环防 run_steps 无限增长)
- dashboard agent 视图(handoff/会话图;顺手处理 Deployments 遗产页);examples/multi-agent。

### P6 — 打磨(持续)
plugin interceptors 全量(client/step/worker/persistence 四类)、eslint-plugin、可挂载 HTTP handler(better-auth 式 `trigger.handler`,供跨服务触发/远程 studio)、query(观察运行中状态)、CLI(`migrate` / `studio`)。

## 北极星 demo(P5 验收)

planner fan-out 3 个 researcher → `gather` 汇总 → `requestApproval` 人工审批 → writer 产出;在任意边界 `kill -9` 进程;重启后 **LLM 调用不重复计费、审批不丢、历史无重复 step、结果正确**。

## 风险

| 风险 | 应对 |
|---|---|
| 嵌入进程与业务共享事件循环/连接池 | kernel 全部短事务;pool 上限可配;文档写明「专用 worker 进程」模式(同库同配置,只是单独跑) |
| 「没进程在线就没人调度」被误解 | README/文档使用承诺表原文;studio 显示「无在线进程」警示 |
| 与业务共库干扰 | 独立 `better_trigger` schema;建议独立 Pool |
| step 非幂等 + at-least-once → 副作用重复 | `ctx.idempotencyKey` 自动提供;文档强调;LLM 步骤给出幂等实践 |
| 确定性被违反 | fingerprint 硬检测 + eslint-plugin + `ctx.now/random/uuid`;VM sandbox 明确为远期(本地跑可信代码) |
| run_steps 无限增长(agent 长循环) | `continueAsNew` + 长度警告;不做 snapshot(与代码版本兼容复杂) |
| 代码升级致重放漂移 | 保留 code_version 锁定;远期 `ctx.patched()` |

## ADR 摘要

1. **嵌入式 no-server(better-auth 形态)** — 2026-07-28 定案;独立 server 取消,studio 为可选工具进程。推翻:backend-contract.md 的 HTTP worker 协议。
2. **step 记忆重放,而非 event-history/command-matching** — 已实现、语义够用;以 fingerprint + correctness suite 硬化,不重写。
3. **API 维持 task/step/wait(Inngest 风格)** — 2026-06-05 用户选定;不采纳 Temporal 表面(defineWorkflow/proxyActivities/WorkflowHandle)。
4. **PG-only v1** — 内部 repository 只是模块边界与测试 seam,不承诺公开 adapter;第二种数据库落地前不抽象。
5. **多 agent 是产品层** — 建立在 P3 signal/event 内核上;第一批仅 handoff/gather/requestApproval + ctx.llm。
