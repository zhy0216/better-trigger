# better-trigger 多 Agent 协作设计

> 子文档,配套 [`PRD.md`](./PRD.md)。本文聚焦一件事:**把 agent 之间的「握手 / 移交 / 协商 / 共享记忆」本身,建模为持久化、可重放、可审计的一等原语。**
>
> 关系定位:本文不重复 PRD 的引擎细节(重放、wait/event、SKIP LOCKED 队列),而是在其之上**新增一层**。文中所有新原语,本质都是现有 `task / step / wait / event / triggerAndWait / batchTrigger / replay` 的**语义糖 + 几张新表**,不引入新的运行时机制、不引入 Redis。
>
> 适用形态:**纯本地 / 纯 self-host**(1 Postgres + 1 进程,homelab 可跑,数据/key/agent 全程不出本机)。

---

## 0. 一句话主张

> 多 agent 协作的每一种模式,本质上都是**「一个 agent 在某个确定性的位置,等待另一个 agent 的结果 / 消息 / 状态变更」**——而这正是 durable execution 的 `wait / event / triggerAndWait` 原语。

竞品(LangGraph state、OpenAI Swarm 返回的 Agent 对象、AutoGen group chat、Letta shared memory)把"协作"放在**内存层**,崩溃即丢、不可重放、不可审计、不可暂停。better-trigger 把 agent 之间的每一次连接写进 Postgres 的 `run_steps / waits / events / handoffs / ...`,使**「agent 拓扑」本身成为持久化数据**,而不是代码运行时的瞬时状态。

这同时是对 Cognition《Don't Build Multi-Agents》三大批判的正面工程化回答:

| Cognition 的批判 | 本设计的回答 |
|---|---|
| 上下文分散 | **强一致共享黑板**(乐观锁 + 版本化变更日志) |
| 移交丢信息 | **schema 合约 + 上下文快照移交**(运行时双向校验,落 `handoffs` 表) |
| 决策冲突 / 各说各话 | **可问责指挥链 + 仲裁**(冲突收口到 `arbitrate`,"谁拍板、为什么"落 `arbitrations` 表) |

---

## 1. 设计总览

```
┌─ 地基层(必做,所有协作的前提)────────────────────────────┐
│  ctx.ai.generate / stream / tool   把 LLM/工具调用 memoize 成 │
│                                    确定性决策对象(非字节)    │
└──────────────────────────────────────────────────────────┘
┌─ 协作原语层(本文重点)──────────────────────────────────┐
│  ctx.spawnAgent   子 agent 生成(= triggerAndWait 语义糖)   │
│  ctx.handoff      控制权移交(transfer / delegate / escalate)│
│  ctx.mailbox      actor 点对点邮箱(ask / tell)             │
│  ctx.blackboard   共享记忆 / 黑板(乐观锁 + watch)          │
│  ctx.gather       扇出-聚合(all / race / quorum / best-of-n)│
│  ctx.arbitrate    一等可重放仲裁决策点                       │
│  ctx.requestApproval  human-in-the-loop(超长挂起零资源)    │
│  ctx.lease        本机物理资源租约(file / gpu / git)       │
│  ctx.budget       并发 / 成本闸                             │
└──────────────────────────────────────────────────────────┘
┌─ 远期可选层(默认关闭,examples 验证后点亮)──────────────┐
│  ctx.negotiate    多轮协商状态机(回合 / quorum / deadlock) │
│  ctx.market       去中心化任务市场(post / bid / award)     │
│  ctx.federation   跨节点 A2A(ask('alice.node://agent'))    │
└──────────────────────────────────────────────────────────┘
```

**推荐协调哲学(三套架构评审后的融合骨架):**

- **Actor 邮箱**做**物理基底** —— 每个 agent 是一个"活着、可寻址、崩溃可恢复"的常驻 durable run,主体是 `while(true){ recv() }`;`recv()` 即挂起释放 worker,与引擎的 `wait.forEvent` 语义同构,几乎零新机制。成千上万常驻 agent 长期挂起几乎不耗资源。
- **可问责指挥链**(Supervisor + arbitrate)做**默认协作模式** —— 子 agent 默认不私自协商,冲突收口到一个可重放、可审计的仲裁点。对本地小模型最友好(决策权集中)。
- **任务市场 / 联邦**做**opt-in 远期层** —— 想象力上限,但有活锁 / 攻击面风险,默认关闭。

---

## 2. 地基:LLM / 工具调用 = memoized step

> 这是所有上层协作能重放的前提:**只有"每次 LLM 决策能重放",上层所有"agent 间的边"才能重放。** 排程铁律:本节(对应 PRD 修订里程碑 M4)必须早于任何协作原语(M5)。

核心思想:**把所有非确定性收口进 step 边界,记忆"决策"而非"字节",并用 fingerprint 主动检测漂移。**

```typescript
// —— ctx.ai.generate:把一次 LLM 推理 memoize 成确定性决策 ——
async function generate(req: GenerateReq, ctx: Ctx): Promise<Turn> {
  // input_fingerprint:归一化哈希(剥离时间戳/随机 id 等已知易变字段)
  const fp = normalizeFingerprint({
    messages: req.messages, tools: req.tools,
    model: ctx.modelFingerprint,            // run 启动时锁定的值
    params: req.params,
  });

  return ctx.step("ai.generate", { fingerprint: fp }, async (prior) => {
    if (prior) {                             // 重放路径:绝不重打 LLM,不重烧 token
      if (prior.fingerprint !== fp)
        throw new NonDeterminismError({      // 不静默漂移
          seq: ctx.seq, expected: prior.fingerprint, got: fp,
          hint: "wrap the changed branch in ctx.patched('tag')",
        });
      return prior.output as Turn;           // 返回当初真实发生的那一次决策
    }
    const res = await ctx.provider.chat(req); // 首跑:直连 Ollama,bytes 不出本机
    return {                                  // 记忆结构化决策对象(非字节)
      text: res.content,
      toolCalls: res.tool_calls,             //   → 后续 ReAct 分支重放时完全确定
      finishReason: res.finish_reason,
      usage: res.usage,                      // token 计费可审计
      modelFingerprint: ctx.modelFingerprint,
    };
  });
}

// —— ctx.ai.tool:二段提交 + 自动派生幂等键(副作用 at-most-once)——
async function aiTool(call: ToolCall, ctx: Ctx) {
  const idem = hash(ctx.runId, ctx.seq, call.name, hash(call.args));
  await ctx.recordToolRequest(call, idem);   // 第一段:tool_call_requested
  return ctx.step(`tool:${call.name}`, async (prior) => {
    if (prior?.result) return prior.result;  // 重放已有 result → 跳过
    // 只有 request 没 result(崩在工具中途)→ 用同一 idem 重试
    return ctx.runTool(call.name, call.args, { idempotencyKey: idem }); // 第二段:result
  });
}
```

四个要点:

1. **记忆决策而非字节** —— 存的是 `{ text, toolCalls[], finishReason, usage, modelFingerprint }`,结构化 `toolCalls` 使后续 ReAct 走向在重放时完全确定。
2. **流式双通道** —— 程序依赖的"最终决策"走 durable step;人要看的"实时 token"走 ephemeral 通道(`key=runId:seq:streamKey`,可丢、重放时一次性 flush 全文)。无需 Redis。
3. **工具二段提交** —— `tool_call_requested` 与 `tool_call_result` 分开,崩在工具执行中途用同一幂等键重试,本机副作用 at-most-once。
4. **变长循环稳定位置键** —— `ctx.loop("react")` 给循环体逻辑命名空间(`(loopName, iter, stepName)`),"上次 5 轮、这次代码改成 7 轮"时前 5 轮仍精确命中缓存。

> ⚠️ **重放安全的命门**:agent 决定"ask 谁 / handoff 给谁"本身是 LLM 非确定路由。**这些路由决策也必须走 `ctx.ai.generate` memoize**,否则重放时整个协作拓扑会漂移。

---

## 3. 九个 agent 连接点(本文核心)

> 每个连接点都落在 **Postgres 一行 + 一个 wait/event** 上,因此天生 durable、可重放、可暂停数月、可 SQL 审计。

### 连接点速查表

| # | 连接点 | 谁 → 谁 / 传什么 | 触发条件 | 底层原语 |
|---|---|---|---|---|
| 1 | **受控移交 handoff** | A 按 zod 合约 + 上下文快照把任务交给 B | A 发现需要别的专家处理 | `triggerAndWait` / active_agent 指针 + `handoffs` 表 |
| 2 | **点对点邮箱 ask/tell** | 专家间快问快答 / 异步通知 | ReAct 中需要另一专家判断 | `wait.forEvent` + `inbox_cursor` 位置键 |
| 3 | **共享黑板 blackboard** | 多 agent 并发写同一块认知 | 产出值得共享的中间结论 | `FOR UPDATE SKIP LOCKED` + version 乐观锁 |
| 4 | **「记忆即消息总线」** | 谁改了某 key → 订阅方被唤醒重放 | 某 memory key 版本自增 | `watch(key)` = `wait.forEvent('bb:...')` |
| 5 | **扇出-聚合 gather** | Supervisor 并行派 N 个子 agent 再收口 | 任务可并行分解 | `batchTriggerAndWait` |
| 6 | **仲裁 arbitrate** | 冲突收口到 judge,落 `arbitrations` 表 | fan-in 后检测到子结论冲突 | `triggerAndWait` 起 judge 子 run |
| 7 | **审批/升级 escalate** | 把"人""更强模型"当升级目标 | 命中授权边界 / 本地模型置信度不足 | `wait.forEvent('approval:id')` + `escalations` 表 |
| 8 | **本机资源租约 lease** | 多 agent 抢同一 git 仓库 / GPU | 同时要写同一本机资源 | `FOR UPDATE SKIP LOCKED` + TTL 回收 |
| 9 | **跨节点联邦**(远期) | 你的 agent ↔ 别人本机的 agent | 本地协作需要邻居节点判断 | `ask('alice.node://agent')` 经 gateway 转译 |

下面逐个给出代码意象与语义。

### 3.1 受控移交 `ctx.handoff` —— agent 间最核心的连接

不是用裸 `triggerAndWait` 拼移交,而是**带 schema 合约 + 上下文快照 + 可重放审计**的一等移交。

```typescript
import { RiskSchema } from "./contracts";

// techAgent 发现技术红旗,需要 finance 按合约重算估值:
const result = await ctx.handoff(financeAgent, {
  context: snapshot,              // 上下文快照(压缩后的 messages,而非全量历史)—— 省 token + 防丢信息
  contract: RiskSchema,          // zod:编译期 TS + 运行时双向校验
  reason: "技术债影响估值,请按 RiskSchema 重算",
  mode: "delegate",              // 父保留控制权,等 finance 结果回填
});
```

三种 `mode`:

| mode | 语义 | 底层映射 |
|---|---|---|
| `delegate` | 父保留控制权,等子结果回填 | `triggerAndWait` 子 agent |
| `transfer` | 尾移交:更新 `thread.active_agent` 指针,当前 agent 不再续跑,A→B→C **不累积调用栈** | `trigger` + `threads` 表迁移指针 |
| `escalate` | 向上交给人或更强模型 | 见 3.7 |

每次移交写一行 `handoffs`(from / to / context_ref / contract_id / reason),**整条移交链可像调用栈回放、可 SQL 审计**。这是对 Cognition"移交丢上下文"批判最直接的工程化回答。

### 3.2 点对点邮箱 `ctx.mailbox` / `ctx.ask` / `ctx.tell`

`recv` 即 wait:挂起释放 worker,到信由 event 唤醒重放,`inbox_cursor`(run_step 位置键)保证 **exactly-once 消费**。

```typescript
// —— 常驻 actor 主体:永不正常返回的 mailbox 循环 ——
export const financeAgent = defineAgent({
  id: "finance-expert",
  model: localModel("ollama/qwen2.5:32b"),
  async onStart(ctx) {
    while (true) {
      // recv 底层:SELECT FROM agent_messages WHERE to=self AND id>inbox_cursor
      //   无新信 → 抛 SuspendSignal(复用 wait.forEvent('mbox:finance-expert')),释放 worker
      const msg = await ctx.mailbox.recv({ timeout: "30d" });
      const verdict = await ctx.ai.generate({ messages: [ctx.ai.user(asPrompt(msg.payload))] });
      if (msg.correlationId) await ctx.reply(msg, ctx.ai.parse(verdict, RiskSchema)); // ask 回信
      // 处理完原子推进 inbox_cursor(写一行 run_step → exactly-once)
    }
  },
});

// —— 同侪点对点请教(ask = send + wait.forEvent(correlationId)) ——
const reply = await ctx.ask("finance-expert", { question }, { timeout: "1h" });

// —— 异步单向通知(fire-and-forget,不等回复) ——
await ctx.tell("release-captain", { event: "rolled-back", pr: 812 });
```

`inbox_cursor` 复用 run_step 位置键,把邮箱的**「有序、不重复消费、崩溃重放不重投递、不重烧 token」四个保证**一次落到已有机制上——这是全设计中对"durable × actor 邮箱"最优雅的同构。

### 3.3 / 3.4 共享黑板 `ctx.blackboard` + 「记忆即消息总线」

子 agent 不直接对话,而是通过同一块强一致共享记忆协作(黑板架构)。`update` 用乐观锁,冲突自动把别人刚写的新值喂回 `fn` 重算,**彻底防丢更新**。

```typescript
// 读:memoized step,保证重放时记忆视图与首跑一致
const thesis = await ctx.memory("deal-thesis").read();

// 改:乐观锁(version + FOR UPDATE SKIP LOCKED);并发冲突自动重试 fn
await ctx.memory("deal-thesis").update((cur) => ({
  ...cur, market: { tam: estimateTam(cur), updatedBy: ctx.agentId },
}));

// 订阅:「记忆即消息总线」。watch = wait.forEvent('bb:deal-thesis:risk')
//   另一 agent 改了该 key → version 自增 emit 事件 → 本 agent 被重放唤醒,边收边聚合
const change = await ctx.memory("deal-thesis").watch("risk");
```

`update` 底层(乐观锁喂回重试 + 变更日志):

```typescript
async function memoryUpdate(blockId, fn, ctx: Ctx) {
  return ctx.step(`mem.update:${blockId}`, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await ctx.db.selectForUpdate("memory_blocks", { id: blockId });
      const next = fn(row.value);
      const ok = await ctx.db.update("memory_blocks",
        { id: blockId, version: row.version },           // 乐观锁:WHERE version = row.version
        { value: next, version: row.version + 1, written_by: ctx.agentId });
      if (ok) {
        await ctx.db.insert("memory_logs", {             // 变更进 logs,可时间线回放
          block_id: blockId, version: row.version + 1,
          delta: diff(row.value, next), agent_id: ctx.agentId, run_id: ctx.runId });
        await ctx.emit(`bb:${blockId}:*`, { version: row.version + 1 }); // 唤醒 watch 订阅者
        return next;
      }
      // 冲突:version 已变,循环重读最新值喂回 fn 重算(避免丢更新)
    }
    throw new BlackboardContentionError(blockId);        // 退避上限 → 防活锁
  });
}
```

`watch(key) = wait.forEvent('bb:scope:key')` 把**「隐式共享认知」与「显式消息通知」统一成同一个原语**。三套架构不约而同采用它,印证它是最关键的跨 agent 连接基石。审计:`select * from memory_logs where block_id='deal-thesis' order by version` 即可回放"这块共享认知怎样被各 agent 逐步建立"。

### 3.5 / 3.6 扇出-聚合 `ctx.gather` + 仲裁 `ctx.arbitrate`

```typescript
export const ddSupervisor = agent({
  id: "dd-supervisor", model: localModel("ollama/qwen2.5:72b"),
  async run(ctx, input) {
    // 1) fan-out:并行派 3 专家(batchTriggerAndWait)。父在 fan-in 点挂起释放 worker,每分支独立可重放
    const results = await ctx.gather(
      [{ agent: financeAgent, input }, { agent: techAgent, input }, { agent: marketAgent, input }],
      { strategy: "all" });   // all | race | quorum:2/3 | best-of-n | debate
    //   每子 run 写 dispatches 行(from=supervisor);outputSchema 校验失败 → 重派

    // 2) 读黑板一致视图,检测冲突
    const thesis = await ctx.memory("deal-thesis").read();
    if (conflict(thesis.finance?.valuation, thesis.market?.valuation)) {
      // 3) 仲裁:把分歧收口到可重放、可审计的决策点(裁决写 arbitrations 表)
      const verdict = await ctx.arbitrate([results.finance, results.market],
        { judge: judgeAgent, policy: "best-of-n" }); // judge 打分走 ctx.ai.generate(可重放)
      thesis.finalValuation = verdict.winner;
    }

    // 4) 出最终结论前命中授权边界 → 审批(见 3.7)
    return ctx.requestApproval({ to: "human", payload: { draft: buildReport(results, thesis) }, timeout: "2d" });
  },
});
```

- `ctx.gather` 把"并行多 agent + 聚合 / 投票 / best-of-n / debate"做成一个原语,**每个分支是 durable 的**(某 agent 崩了只重放那一支,慢分支挂起释放 worker)。
- `ctx.arbitrate` 把"指挥官如何收口分歧"做成一等可重放决策点,`select * from arbitrations` 可审计**谁拍板、为什么**——直接回答 Cognition 批判的"决策冲突"。
- ⚠️ 失控 fan-out 会瞬间打满本机 LLM 并发,需 `ctx.budget` 并发闸兜底。

### 3.7 审批 / 升级 `ctx.requestApproval` / `ctx.escalate`

把**人**和**更强模型**都建模成升级边界上的特殊参与者。审批挂起释放 worker、机器可关机睡到第二天,审批决策进可重放轨迹。

```typescript
const decision = await ctx.requestApproval({ to: "human", payload: { draft }, timeout: "2d" });
// 底层:写 escalations 行 + wait.forEvent('approval:'+id);进程挂起、worker 归零、可关机过夜
//   本机 dashboard 点'批准' → API publish('approval:'+id) → run 重放从此处无缝续跑

// escalate:统一 human 与 stronger-model 两种升级目标
//   target='human'          → wait.forEvent('approval:id')(挂起零资源等数天)
//   target='stronger-model' → 换一个锁定更高 model_fingerprint 的 ctx.ai.generate 重算(显式策略)
```

### 3.8 本机资源租约 `ctx.lease` —— 纯本地独有的连接

把 `file:///repo`、`device://gpu0`、`git://repo#branch` 变成 durable 可争用对象(复用 `FOR UPDATE SKIP LOCKED`),让多个本地 agent 同时改同一 git 仓库 / 抢同一 GPU 而不打架。

```typescript
const repo = await ctx.lease("git://repo#main", { mode: "exclusive", ttl: "10m" });
// 持有期间,其他 agent 的并发分支在 wait.forEvent('lease.released:git://repo#main') 挂起
// 持有者完成 emit 'lease.released' 唤醒等待者;崩溃但未续约的租约由编排器 TTL 回收
await ctx.step("rebase", () => gitRebase());  // step 边界自动续约
```

这是只有本地形态才成立的原语——所有 durable 引擎的并发控制只感知"逻辑 key",从不绑定"本机物理资源 URI";云端根本没有"本机文件 / GPU"概念。

### 3.9 跨节点联邦(远期,默认关闭)

```typescript
// 你本机的 agent 与邻居节点的 agent 直接 A2A 协商
const r = await ctx.ask("alice.node://release-captain",
  "我 hold 了发版,你那边下游要不要也 hold?");
// 经 FederationGatewayAgent 转译成对端 event;对端 agent replay 处理后跨网回投本地 mailbox
// 双方 key / 数据各留本机(远端用自己的 key 调自己的 LLM)
```

> ⚠️ 联邦打开真实攻击面:跨节点 ask = 让别人 agent 花你的 token / prompt 注入操纵你的 agent。**默认回环,需认证 + 能力授权 + 配额 + 工具白名单**才可 opt-in 暴露。

---

## 4. Agent 名册与联系图

### 推荐 agent 名册(Actor 邮箱基底 + 指挥链默认模式)

| Agent | 角色 | 形态 |
|---|---|---|
| **Concierge(前台)** | 唯一对外入口的常驻 actor:接请求 / webhook / cron、判意图、handoff 给专家或 spawn 编队、汇报结果 | 常驻 |
| **Supervisor(监工)** | 持有一组 worker agentId 的特殊 actor:`gather` 派活、聚合、`arbitrate` 仲裁。**不亲自干活** | 常驻 / 按需 |
| **Worker 专家 ×N** | 指挥链叶子,真正干活:内部 ReAct,把发现写黑板,需要别的专家时 `ask` 或 `handoff` | 可常驻可 spawn |
| **Judge(裁判)** | 被 `arbitrate` / `gather best-of-n` 引用,打分 / 投票拍板;**是 quorum 一员但无指挥权** | 按需 |
| **Memory Keeper(记忆管家)** | 守护共享黑板:版本化、压缩上下文供 handoff(省 token)、维护变更日志、变更时唤醒订阅者 | 常驻(可选) |
| **Human-in-the-loop(人)** | 接入协作网格的特殊 actor:协商 quorum 一员 / 审批边界决策者;"邮箱"= Dashboard 审批队列 | — |

### 联系图(尽调小组场景)

```
   用户 / webhook / cron
        │ tell + emit('mbox:concierge')
        ▼
  ┌─────────────┐
  │  Concierge  │  判定为复合任务
  └─────────────┘
        │ ① ctx.handoff(Supervisor, {context快照, contract, mode:'delegate'})
        │    = triggerAndWait + handoffs 行;Concierge 挂起释放 worker
        ▼
  ┌─────────────┐
  │ Supervisor  │  ② ctx.gather([finance,tech,market], {strategy:'all'})
  └─────────────┘     = batchTriggerAndWait;父在 fan-in 点挂起释放 worker
     │     │     │      每分支写 dispatches 行(from=supervisor)
     ▼     ▼     ▼
 ┌──────┐┌──────┐┌──────┐
 │ tech ││finan.││market│   每个 = 独立子 run,崩溃只重放该子树
 └──────┘└──────┘└──────┘
     │       ▲
     │       │ ③ tech 发现技术红旗 → ctx.handoff(finance, {contract:RiskSchema, mode:'delegate'})
     │       │ ④ tech↔finance 快问快答 → ctx.ask('finance', q) = agent_messages + wait.forEvent
     ▼       ▼
 ╔══════════════════════════════════════════════╗
 ║  共享黑板 ctx.blackboard('deal-thesis')        ║  ⑤ 三专家并发 update(乐观锁,不互相覆盖)
 ║  .update(fn) 乐观锁 / .watch(key) 记忆即总线   ║  ⑥ 谁改了 key → 订阅方被重放唤醒,边收边聚合
 ╚══════════════════════════════════════════════╝
            │ emit('bb:deal-thesis:*')
            ▼
  ┌─────────────┐  ⑦ 检测 finance↔market 估值分歧 →
  │ Supervisor  │     ctx.arbitrate([financeTurn, marketTurn], {judge, policy:'best-of-n'})
  └─────────────┘     = triggerAndWait 起 Judge 子 run
        │
        ▼
  ┌─────────────┐  打分走 ctx.ai.generate(可重放)→ 裁决写 arbitrations 表
  │   Judge     │  → triggerAndWait 回填给 Supervisor
  └─────────────┘
        │ ⑧ 出最终结论前 → ctx.requestApproval({to:'human', timeout:'2d'})
        ▼    = escalations 行 + wait.forEvent('approval:id')【进程挂起、worker 归零】
  ┌─────────────┐  本机 Dashboard / 手机点'批准' → publish('approval:id') → run 重放无缝续跑
  │   Human     │
  └─────────────┘
        │ ⑨ Supervisor → ctx.handoff(Concierge, 报告) → tell(user, 最终报告)
        ▼
  ──────────────────────────────────────────────────────────────────
  横切 A:多 agent 争用本机资源 → ctx.lease('git://repo#main',{exclusive})
  横切 B:任一节点崩溃 / 机器睡眠 → replay:已完成 ai.generate/tool/黑板按位置键命中缓存秒回,
          流式瞬时 flush;挂起的 wait(协商 / 审批 / 租约)从 waits 表恢复续跑
```

---

## 5. 端到端 trace(含挂起 / 重放 / 审批)

> 场景:homelab 离线(Mini PC + 本地 Postgres + Ollama,**全程断网**)跑"尽调小组",指挥链 Orchestrator(根 run #100)统筹。

| 阶段 | 发生了什么 |
|---|---|
| **T0 触发** | `trigger('due-diligence', {deal})`。建根 run #100,启动锁定 `code_version` + 每个 agent 的 `model_fingerprint`(防中途换模型漂移) |
| **T1 分派** | Orchestrator `ctx.ai.generate` 做任务分解(seq=1,memoized)→ `gather` → batchTriggerAndWait 起子 run #101/#102/#103,各写一行 `dispatches`。父 #100 在 fan-in 点 wait,worker 释放 |
| **T2 并行 + 黑板** | 三 worker 各跑 ReAct(每轮 `ai.generate` + `tool` 都是 memoized step)。#102 与 #103 同时 `blackboard.update` → 乐观锁:#103 写时发现 version 已被 #102 改,自动喂回 fn 重算,无丢更新 |
| **T3 受控移交** | techAgent 发现技术红旗 → `ctx.handoff(financeAgent, {contract:RiskSchema, mode:'delegate'})`,登记指挥链(parent=#100),triggerAndWait 让 finance 重算估值 |
| **T4 崩溃 + 重放** | 机器睡眠重启。引擎重放:#101/#102/#103 已完成的 `ai.generate` **全部命中 Postgres 缓存、不重烧本地算力**;流式瞬时 flush;techAgent 跑到第 4 轮才崩 → 前 3 轮按 `(loop,iter,step)` 位置键回放、只重跑第 4 轮 |
| **T5 fan-in + 冲突** | 三子 run 完成 emit `run.completed` 满足 #100 的 batch wait,#100 被重放唤醒,三份 turn 按 `outputSchema` 校验回填。读黑板一致视图,检测到 finance↔market 估值分歧 |
| **T6 仲裁** | `ctx.arbitrate([financeTurn, marketTurn], {judge, policy:'best-of-n'})` → triggerAndWait 起 Judge 子 run #104。Judge `ai.generate` 打分,裁决写 `arbitrations`,回填 #100 |
| **T7 审批挂起** | Orchestrator 出最终结论前 → `ctx.requestApproval({to:'human', timeout:'2d'})` → `wait.forEvent('approval:100')`。**进程挂起、worker 归零、机器可关机过夜**,请求入 `escalations` |
| **T8 审批复活** | 第二天点'批准' → `publish('approval:100')`。#100 重放:此前所有 step 命中缓存秒回,从 escalate 点无缝续跑,产出最终报告 |

**全程 0 token / 0 deal 数据 / 0 API key 离开本机。** SQL 可审计:

```sql
select * from dispatches   where run_id = 100;  -- 谁向谁分派了什么
select * from handoffs     where run_id = 100;  -- 谁向谁移交了什么、为什么
select * from arbitrations where run_id = 100;  -- 仲裁了什么、谁拍的板、理由
select * from memory_logs  where block_id = 'deal-thesis' order by version; -- 共享认知如何被逐步建立
select * from escalations  where run_id = 100;  -- 何时升级给人、人怎么批的
```

---

## 6. 数据模型增量

> 复用现有表(不改语义):`runs`(增字段)、`run_steps`(memoize 决策对象与工具二段)、`events`(pub-sub)、`waits`(挂起态)、`logs`。

### 6.1 现有表字段增量

```sql
-- runs:agent 身份、版本锁定、actor 邮箱游标
ALTER TABLE runs ADD COLUMN agent_id          text;            -- 哪个 agent 在跑(关联 agents)
ALTER TABLE runs ADD COLUMN thread_id         uuid;            -- 跨 handoff 的会话线程
ALTER TABLE runs ADD COLUMN model_fingerprint text;            -- 启动锁定的模型指纹(防漂移)
ALTER TABLE runs ADD COLUMN inbox_cursor      bigint DEFAULT 0;-- actor 邮箱 exactly-once 游标
ALTER TABLE runs ADD COLUMN is_resident       boolean DEFAULT false; -- 常驻 actor vs 一次性

-- run_steps:AI 决策对象 + 工具二段提交 + 漂移检测
ALTER TABLE run_steps ADD COLUMN kind              text;  -- 'ai.generate'|'tool.req'|'tool.res'|'mem.update'|...
ALTER TABLE run_steps ADD COLUMN input_fingerprint text;  -- 归一化哈希,重放比对防漂移
ALTER TABLE run_steps ADD COLUMN idempotency_key   text;  -- 工具副作用 at-most-once
ALTER TABLE run_steps ADD COLUMN usage_json        jsonb; -- token usage(计费审计)
-- output 已存结构化决策对象 { text, toolCalls[], finishReason, modelFingerprint }
```

### 6.2 新增表(MVP)

```sql
-- 1) agents:agent 注册表(本地 Agent Card)
CREATE TABLE agents (
  id            text PRIMARY KEY,
  model         text NOT NULL,
  instructions  text,
  capabilities  text[],                       -- 供 ctx.discover / 任务市场
  input_schema  jsonb, output_schema jsonb,   -- zod → JSON Schema
  version       text NOT NULL,
  created_at    timestamptz DEFAULT now()
);

-- 2) agent_messages:actor 邮箱(发件箱模式,exactly-once)
CREATE TABLE agent_messages (
  id             bigserial PRIMARY KEY,        -- 即 seq;接收方 inbox_cursor 据此推进
  thread_id      uuid,
  from_agent     text, to_agent text NOT NULL,
  correlation_id uuid,                         -- ask/reply 配对;tell 为 null
  payload        jsonb NOT NULL,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX ON agent_messages (to_agent, id); -- recv 的 WHERE to=self AND id>cursor

-- 3) handoffs:控制权移交(可像调用栈回放)
CREATE TABLE handoffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid, thread_id uuid,
  from_agent  text, to_agent text NOT NULL,
  mode        text NOT NULL,                   -- 'transfer'|'delegate'|'escalate'|'consult'
  contract_id text,                            -- 关联 zod 契约版本
  context_ref text,                            -- 上下文快照存储引用(非全量历史)
  reason      text,
  created_at  timestamptz DEFAULT now()
);

-- 4) dispatches:supervisor → worker 的受控分派(指挥链审计)
CREATE TABLE dispatches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_run_id uuid,                          -- 指向 supervisor(指挥链)
  from_agent    text, to_agent text NOT NULL,
  contract_id   text, snapshot_ref text,
  status        text DEFAULT 'pending',        -- pending|completed|schema_failed|retried
  created_at    timestamptz DEFAULT now()
);

-- 5) memory_blocks + memory_logs:共享黑板(乐观锁 + 版本化变更日志)
CREATE TABLE memory_blocks (
  id         text PRIMARY KEY,                 -- blockId,如 'deal-thesis'
  label      text,
  value      jsonb NOT NULL,
  version    bigint NOT NULL DEFAULT 0,        -- 乐观锁
  owners     text[],
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE memory_logs (
  block_id   text, version bigint,
  delta      jsonb, agent_id text, run_id uuid,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (block_id, version)
);

-- 6) arbitrations:仲裁裁决(谁拍的板、为什么)
CREATE TABLE arbitrations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid, judge_agent text,
  candidates jsonb,                            -- N 个候选 turn 引用
  policy     text,                             -- 'majority'|'best-of-n'|'merge'
  winner     jsonb, scores jsonb, rationale text,
  created_at timestamptz DEFAULT now()
);

-- 7) escalations:升级/审批(human / stronger-model)
CREATE TABLE escalations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid, kind text,                  -- 'human'|'stronger-model'
  payload    jsonb,
  decision   jsonb,                            -- approve|reject|amend (+ 指令)
  decided_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 8) threads:跨 handoff 会话线程(transfer 用 active_agent 指针)
CREATE TABLE threads (
  id           uuid PRIMARY KEY,
  active_agent text,                           -- 尾移交时迁移此指针
  created_at   timestamptz DEFAULT now()
);

-- 9) leases:本机物理资源租约(file:///repo、device://gpu0、git://repo#branch)
CREATE TABLE leases (
  resource_uri  text PRIMARY KEY,
  holder_run_id uuid, mode text,
  expires_at    timestamptz                    -- FOR UPDATE SKIP LOCKED 争用,TTL 回收
);
```

### 6.3 可选高级层(默认关闭,examples 验证后点亮)

```sql
-- 任务市场:去中心化 capability 发现 + 竞标撮合
CREATE TABLE market_postings ( id uuid PRIMARY KEY, capability text, need jsonb,
  budget jsonb, deadline timestamptz, award_strategy text, status text );
CREATE TABLE bids ( id uuid PRIMARY KEY, posting_id uuid, bidder_agent text,
  price jsonb, plan jsonb, confidence numeric, status text );

-- 多轮协商:带回合 / quorum / deadlock 的可重放状态机
CREATE TABLE negotiations ( id uuid PRIMARY KEY, topic text, participants text[],
  round int, proposal jsonb, by_agent text, quorum_rule text, status text );
```

---

## 7. 新增 SDK 原语清单

**MVP(对应 PRD 修订里程碑 M4 + M5):**

| 原语 | 一句话语义 | 底层 |
|---|---|---|
| `ctx.ai.generate / stream / tool` | LLM/工具调用 memoize 成结构化决策 step(地基) | `step` + ephemeral 通道 |
| `agent({...})` | 定义 agent(model/instructions/tools/memory/契约),登记 `agents` 表 | `task` 之上的工厂 |
| `ctx.spawnAgent(child, input)` | 子 agent 生成,父挂起等结果 | `triggerAndWait` |
| `ctx.gather(branches, {strategy})` | fan-out/fan-in(all/race/quorum/best-of-n/debate) | `batchTriggerAndWait` |
| `ctx.handoff(target, {context, contract, mode})` | 三态持久移交 | `triggerAndWait` / active_agent 指针 |
| `ctx.mailbox.recv/send` + `ctx.ask / ctx.tell` | actor 点对点消息(exactly-once) | `wait.forEvent` + `inbox_cursor` |
| `ctx.blackboard(scope).read/update/watch` | 乐观锁共享黑板(记忆即总线) | `FOR UPDATE SKIP LOCKED` + `event` |
| `ctx.arbitrate(candidates, {judge, policy})` | 一等可重放仲裁决策点 | `triggerAndWait` |
| `ctx.requestApproval / ctx.escalate` | human-in-the-loop / 模型升级 | `wait.forEvent` |
| `ctx.lease(uri, {mode, ttl})` | 本机物理资源租约 | `FOR UPDATE SKIP LOCKED` + TTL |
| `ctx.budget(...)` | 并发 / 成本闸(防失控 fanout) | 计数器 + 限流 |
| `ctx.loop(name) / ctx.patched(tag)` | 变长循环稳定位置键 + 漂移兜底 | 位置键命名空间 |

**远期可选层(默认关闭):** `ctx.negotiate`、`ctx.market.post/bid/award`、跨节点 `ctx.ask('alice.node://...')` 联邦、`ctx.forkFrom(seq, overrides)`(时间旅行调试 + run→eval)。

---

## 8. MVP 边界与落地纪律

**只做一个必做创新 + 最少原语:**

- **唯一不可绕过的地基:`ctx.ai.*`(LLM 语义级 memoization)。** 没有它,后面所有 agent 协作都不能重放。
- **最少 agent 原语两个:`ctx.spawnAgent` + `ctx.blackboard`。** 调研明确"80% 场景只需移交 + 共享记忆";spawnAgent 复用现成 `triggerAndWait`(几乎零新机制),blackboard 是"记忆即总线"的统一基石。
- 加一个体感件:`ctx.requestApproval`(展示"超长挂起零资源")。
- `handoff / mailbox / arbitrate / lease` 作 MVP+1;`negotiate / market / federation / fork-eval` 推到远期。

**排程铁律:LLM-as-step(M4)必须早于任何 multi-agent 原语(M5)** —— "agent 间的边能重放"依赖"每次 LLM 决策能重放"。

**30 秒 demo —— 本机代码审计小组(可断网):**

1. **(0–15s)** Supervisor `batchTriggerAndWait` 并行 spawn 3 个 reviewer,各自写 `ctx.blackboard('findings')`(乐观锁不互相覆盖)。dashboard 时序图**实时打字机思考**,角标:**"本次 run:0 字节出本机"**。
2. **(15–25s)** 当场 **Ctrl-C 杀进程再 `bt up` 重启** → 时序图瞬间重现已完成思考(从缓存重放),只有未完成那一支继续真跑。角标:**"重放命中 N 次 LLM 调用,节省 X token"**。
3. **(25–30s)** Supervisor 提 PR 前命中 `requestApproval` → 进程**挂起、worker 归零(htop CPU 掉到 0)**,手机点"批准"复活。收尾 `select * from blackboard / handoffs where run_id=...` 当场 SQL 审计。

**记忆点:杀进程不丢思考、不重烧 token、挂起零占用、全程不出本机、SQL 可审计。**

---

## 9. 取舍与风险

| 风险 | 缓解 |
|---|---|
| **LLM 路由本身非确定**(决定 ask 谁 / handoff 给谁),重放拓扑漂移 | `handoff / ask / gather` 的**目标选择必须走 `ctx.ai.generate` memoize**(固化决策,而非重新让 LLM 决) |
| **`input_fingerprint` 误报**(prompt 带时间戳 / 随机 id),频繁打断开发 | 可配置**软漂移模式** + 规范化剥离已知易变字段;`ctx.now/random/uuid` 收口;误报率进护栏指标 |
| **`model_fingerprint` 锁定失效**(provider 悄悄升级同名模型) | 明确降级策略(报错 / 软漂移 / 重跑),做成显式配置,**绝不静默漂移** |
| **流式 token 重放**:多数 provider 做不到"从第 N 个 token 续接" | 诚实降级为整段缓存回放,**不过度承诺"断点续 token"** |
| **本地小模型能力天花板**(judge / 协商需强推理) | 支持混合:本地跑廉价 agent,敏感外环节可选远程强模型,做成**显式 per-step 策略**(不破坏"敏感数据不出本机") |
| **黑板乐观锁活锁**(两 agent 反复互覆盖) | 退避 + 最大重试上限 + `BlackboardContentionError` → 升级仲裁 |
| **常驻 actor + 高频邮箱对 Postgres-only 的新负载** | `agent_messages(to,id)` 索引;到期扫描 / 公平性需队列设计;`ctx.budget` 兜底;**诚实标注扩展上限**(不走回需要 Redis 的老路) |
| **`ctx.lease` 是逻辑租约 ≠ OS 真锁**(外部进程绕过即失效) | MVP 定位"协作内部约定",远期补 OS advisory lock |
| **安全模型反转**(agent 直连本机 fs/shell,一次注入即 rm -rf) | **纯本地单租户消解 gVisor 需求**,代之以:工具白名单 + 审批边界 + 定位"只跑你信任的 agent" |
| **与 MCP / A2A 的关系** | **兼容优先不站队**:tool 层可挂载本地 MCP server(自动 memoize 成 step + 受 lease 保护);handoff/mailbox 设计成可桥接 A2A(默认回环、显式 opt-in)。叙事:"你可以继续用喜欢的 agent 框架,跑在 better-trigger 的 durable 本地运行时上" |
| **高阶原语过度设计**(变成没人用的 DSL) | `negotiate / market / federation` 全部远期、examples 验证后再点亮 |

---

## 附:与现有 PRD 的对接

本文对应 PRD 的以下改动(详见 PRD 嫁接建议):

- **保留**:PRD §3 核心决策、§5–6 引擎、§7 核心表、§9 队列调度 —— 它们就是本文所有原语的底层映射。
- **砍出 v1**:PRD §1.1 + §11 托管算力 SaaS、gVisor 沙箱、构建流水线 / 对象存储、§13 M4。腾出预算前移给 agent 运行时。
- **降级单租户**:多租户 / api_keys → 单租户;secrets → 本机 key vault。
- **新增章节**(本文即其设计依据):LLM-as-step、多 agent 一等原语、指挥链 + arbitrate、`ctx.lease`、本地隐私边界、与 MCP/A2A 关系。
- **修订里程碑**:M4 = LLM-as-step 地基;M5 = 多 agent 协作核心 MVP + 指挥链 + Dashboard 多 agent 因果时序图;M6(默认关闭)= fork/replay + run→eval + negotiate + market + 联邦。
