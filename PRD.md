# better-trigger PRD

> ⚠️ **SUPERSEDED — 本文档已被 [`docs/architecture.md`](./docs/architecture.md) 取代**(2026-07-29 定案)。
> 产品形态是**客户端 / worker daemon 分离**:应用只装 `better-trigger`(定义 task + HTTP 触发,不碰 pg),
> 执行/队列/编排/API 全在 `better-trigger-worker` 一个进程里。
> (中途 2026-07-28 曾定案「嵌入式无 server」,已于 2026-07-29 推翻,见 architecture.md ADR 6。)
> §11 托管算力 SaaS / gVisor 与里程碑 M4 **废弃**。本文仅作历史背景保留,不再维护。

> 一个**更简单、更易自托管**的 trigger.dev 替代品。
> 一句话定位:**一个 Node 服务 + 一个 Postgres,就能跑起来的持久化任务编排平台。**
>
> **部署形态**(同一套 worker 运行时 + SDK + 协议,区别只在“谁启动 worker”):
> - **(1) self-host**:单租户,用户自己跑 server / Postgres / worker。跑的是自己的可信代码 → **不需强隔离**。
> - **(2) 托管算力 SaaS**:用户 `deploy` 上传代码,**平台构建并运行**(在 **gVisor** 沙箱里跑 worker)。用户零运维。

---

## 1. 背景与动机

trigger.dev 功能强大,但自托管很"重":需要 **Postgres + Redis + ClickHouse + 对象存储 + Docker(甚至 Docker-in-Docker)**,外加 webapp、supervisor、多个 worker 组件。它的复杂度主要来自两点:

1. **任务执行隔离**:用容器 / 检查点(checkpoint)实现可中断、可恢复的长任务。
2. **可观测性**:日志走 ClickHouse,状态走 Postgres,队列走 Redis。

`better-trigger` 的目标是**砍掉所有重型依赖**,用"重放(replay)"模型替代容器快照,做到:

- self-host = **1 个 Postgres + 1 个 server 进程**(无 Redis / 无 ClickHouse / 无 Docker-in-Docker)。
- 开发者用**类型安全的 TS SDK** 声明任务,体验接近 trigger.dev / Inngest。
- 支持**重试、定时(cron)、并发控制、超长 wait、可恢复**等核心能力。

### 1.1 SaaS = 托管算力(平台跑代码)

本项目的 SaaS 采用**托管算力**模型(trigger.dev 同类):用户 `deploy` 上传代码 → 平台构建 → 在 **gVisor 沙箱**里跑 worker。用户零部署、零运维。

| | self-host | 托管算力 SaaS(本项目) |
|---|---|---|
| 谁跑用户代码 | 用户自己(可信) | **平台**(gVisor 沙箱) |
| 代码上传 | 否 | **是**(`deploy` 打包) |
| 隔离 | 不需(自己代码) | **gVisor**(跑不可信多租户代码) |
| 额外依赖 | 无 | 构建流水线 + 对象存储 + 计算编排 |

**这是一次向“重”的转向**:为了让用户零运维,平台必须承担代码上传、构建、强隔离、制品存储、密钥托管等责任。以下设计在此前提下展开。

**「极简」仍保留给 self-host**:self-host 跑的是用户自己的可信代码,**不开启 gVisor / 构建流水线 / 对象存储**——仍是“1 Postgres + server + 跑 worker”。重量集中在你托管的 SaaS。

**引擎复用**:两种形态用**同一套 worker 运行时 + 重放引擎 + 协议**,只是“谁启动 worker、是否沙箱”不同。

---

## 2. 目标 / 非目标

### 2.1 目标(v1)
- 声明式、类型安全的任务 SDK(`task` / `step` / `wait` / `trigger`)。
- 持久化执行:崩溃可恢复、步骤级重试、超长等待。
- 独立 worker 进程模型:用户代码与平台隔离,可独立扩缩容。
- 内置队列(Postgres)、重试(指数退避)、cron 调度、并发限制。
- Web Dashboard:任务列表、运行历史、运行详情 + 日志、手动触发 / 重试。
- 极简 self-host 部署:`docker compose up` 或单二进制 + Postgres(不含托管算力的重依赖)。
- **托管算力 SaaS**:`deploy` 代码上传 + 构建流水线 + **gVisor 沙箱**运行 + 制品/对象存储 + 密钥托管。见 §11。
- **多租户**:project/environment、API key 鉴权、用量计量。

### 2.2 非目标(v1 明确不做)
- ❌ **容器 / 进程快照**(CRIU/Firecracker checkpoint):仍用重放模型,不做透明 await 冻结。
- ❌ **编译期 CPS 变换**(魔法编译器):破坏可调试性与"简单易懂"命脉。
- ❌ 透明 `await` 持久化(任意 await 点冻结)。
- ❌ 计费/付费墙(v1 只做**计量**埋点,不做支付/账单)。
- ❌ ClickHouse 级日志分析、分布式追踪。
- ❌ Firecracker microVM(v1 用 gVisor;更强隔离列为远期)。
- ❌ self-host 的托管算力(self-host 单租户跑可信代码,用普通进程/容器,不上 gVisor)。

---

## 3. 核心设计决策(已锁定)

| 维度 | 决策 | 理由 |
|---|---|---|
| 执行模型 | **独立 worker 进程**:server 只编排/存状态,worker 拉任务执行 | 无 Docker、用户代码隔离、可独立扩容 |
| 存储 + 队列 | **仅 Postgres**,队列用 `FOR UPDATE SKIP LOCKED` | self-host 最低门槛;无 Redis |
| 持久化执行 | **重放(replay)模型** + 内联 `step(name, fn)` 边界 | 代码自然(直线 async),实现最简,DBOS/Inngest 验证 |
| 长等待 | **显式 wait 原语**(`wait.for/until/forEvent`),挂起释放 worker | 支持超长等待而不占资源 |
| 确定性 | `ctx.now()` / `ctx.random()` + **ESLint 插件**防坑;沙箱列为远期 | 90% 安全,近零基础设施成本 |
| 版本演进 | 借鉴 Temporal `patched()`:在途 run 锁定启动时的代码版本 | 防止代码改动导致重放漂移 |
| SDK 风格 | **Inngest 式内联 step + 直线 async** | 用户选定(最自然) |
| 部署形态 | **self-host(轻) + 托管算力 SaaS(重)**,同一套引擎 | 轻量自托管 + 零运维商业化兼得 |
| SaaS 隔离 | **gVisor 沙箱**(拦截 syscall) | 多租户跑不可信代码;比 microVM 轻、比普通容器安全 |
| 代码投递 | **CLI `deploy` 打包上传**(esbuild bundle) | 直接,trigger.dev 路线 |
| 多租户 | **project + environment(dev/prod)维度**,行级隔离 + API key | SaaS 刚需;self-host 默认单租户 |

### 3.1 为什么是"重放"
没有容器快照,worker 进程无法在 `wait.for("24h")` 期间把 JS 内存状态冻结。重放模型:任务函数从头重跑,已完成的 `step()` 直接返回持久化的缓存结果,已满足的 `wait` 直接跳过,于是"看起来"是从挂起点继续。

代价:**step 之间的代码必须确定性**。缓解手段见 §6.3。

---

## 4. 系统架构

```
┌──────────────┐      HTTP (REST + long-poll)      ┌───────────────────────┐
│   Worker(s)  │  ───────────────────────────────▶ │        Server         │
│ (用户 Node    │  ◀─────────────────────────────── │  (Hono API + 引擎)     │
│  进程 + SDK)  │   dequeue / report / heartbeat    │                       │
└──────────────┘                                    │  ┌─────────────────┐  │
       ▲                                            │  │  Orchestrator   │  │
       │ 注册 task 定义                              │  │ (重放/调度/重试) │  │
       │                                            │  └─────────────────┘  │
┌──────────────┐                                    │  ┌─────────────────┐  │
│   Dashboard  │  ── HTTP ──▶                        │  │   Queue (PG)    │  │
│ (React/Vite) │                                    │  └─────────────────┘  │
└──────────────┘                                    └───────────┬───────────┘
                                                                │
                                                       ┌────────▼────────┐
                                                       │    Postgres     │
                                                       │ 状态/队列/日志   │
                                                       └─────────────────┘
```

### 4.1 组件职责
- **Server(平台/控制面)**:HTTP API;编排器(决定下一步该跑哪个 step / 何时 resume);队列、重试、cron 调度;持久化状态与日志;多租户隔离 + API key 鉴权;Dashboard 后端。
- **Build 流水线(仅 SaaS)**:接收 `deploy` 上传的 bundle → esbuild 打包 → 生成可运行制品 → 存对象存储/仓库。
- **计算编排器(仅 SaaS)**:按 run 需求在 **gVisor 沙箱**里拉起/复用 worker(热池),加载该租户制品与密钥,管理冷启动与自动扩缩容。
- **Worker(运行时)**:加载 task 定义;连平台 dequeue;执行 step;上报结果/日志/心跳。**self-host**:用户自启(可信,无沙箱);**SaaS**:由计算编排器在 gVisor 里启动(不可信)。同一运行时。
- **Dashboard**:只读 + 操作(手动触发 / 重试 / 取消 / 查看部署)。

### 4.2 执行的关键流程(重放循环)
1. `trigger()` 创建一个 **Run**(状态 `queued`),入队一个 **Task(执行单元)**。
2. Worker dequeue 到该 Run,**从头执行** task 函数:
   - 遇到 `step("x", fn)`:查该 Run 是否已有 `x` 的持久化结果。
     - 有 → 直接返回缓存值(不执行 fn)。
     - 无 → 执行 fn,把结果写回 server,继续。
   - 遇到 `wait.for("24h")`:查是否已到期。
     - 未到期 → 抛出内部 **Suspend 信号**,Run 状态变 `waiting`,写一行 `resume_at`,**worker 被释放**。
     - 已到期 → 跳过,继续。
3. 到期 / 事件到达 → 编排器把 Run 重新入队 → 回到步骤 2(重放)。
4. 函数正常返回 → Run 状态 `completed`,存 output。抛错 → 按重试策略处理。

### 4.3 部署拓扑对比:self-host vs 托管算力 SaaS

> 关键:**两种形态用同一套 worker 运行时 + 重放引擎 + 协议**。区别在“谁启动 worker、是否沙箱、代码是否上传”。

**形态 A — self-host(轻：全在用户基础设施内，跑可信代码，无沙箱)**

```
╔══════════════════ 用户的基础设施(VPC / 内网) ══════════════════╗
║                                                                  ║
║   ┌──────────────┐   出站/内网    ┌───────────────────────┐      ║
║   │  App 代码     │ ── trigger() ─▶│      Server           │      ║
║   │ (trigger key)│                │  (Hono API + 编排器)   │      ║
║   └──────────────┘                │                       │      ║
║   ┌──────────────┐  long-poll     │   单租户(default)     │      ║
║   │  Worker(s)   │ ◀────拉任务────▶│                       │      ║
║   │ 用户代码+SDK  │   上报/心跳     └───────────┬───────────┘      ║
║   └──────────────┘                            │                  ║
║                                       ┌────────▼────────┐         ║
║                                       │    Postgres     │ 用户自管 ║
║                                       └─────────────────┘         ║
║   部署 = docker compose up(server + postgres)+ 跑 worker         ║
╚══════════════════════════════════════════════════════════════════╝
   数据与代码全部留在用户边界内;运维由用户负责。
```

**形态 B — 托管算力 SaaS(重:平台构建并在 gVisor 里跑用户代码)**

```
  用户侧                          平台(SaaS)
┌──────┐  deploy 上传   ┌───────┐   生成制品   ┌──────────────┐
│ CLI  │───────────────▶│ Build │────────────▶│ 对象存储/仓库 │
└──────┘                └───────┘             └──────┬───────┘
┌──────┐  trigger()     ┌─────────┐                  │
│ App  │───────────────▶│  编排器  │◀── 拉起 worker ─┐ │
└──────┘                └────┬────┘                 │ │  ┌──────────┐
                            │  制品+密钥             │ └─▶│ Postgres │
                       ┌────▼────────────┐          │    └──────────┘
                       │ gVisor 沙箱      │──────────┘
                       │ 跑用户代码 worker │   上报/日志
                       └─────────────────┘
   代码、密钥、数据均进平台;用户仅需 deploy。
```

**对比速查**

| 维度 | self-host(A,轻) | 托管算力 SaaS(B,重) |
|---|---|---|
| 谁跑用户代码 | 用户自启 worker | **平台(gVisor 沙箱)** |
| 代码上传 | 否 | **是(`deploy` 打包)** |
| 隔离 | 无(可信代码) | **gVisor** |
| 额外依赖 | 无 | **构建流水线 + 对象存储 + 计算编排** |
| 密钥在哪 | 用户侧 | **平台托管** |
| 数据存哪 | 用户 Postgres | 平台 Postgres |
| 多租户 | 单租户 default | **project + env 隔离** |
| 运维负担 | 用户负责全部 | **用户零运维** |
| 适合谁 | 数据合规/自控 | 开箱即用/零运维 |

---

## 5. SDK 设计

包名(暂定):`better-trigger`。

### 5.1 最简任务(零样板)
```ts
import { task } from "better-trigger";

export const sendEmail = task("send-email", async (payload: { to: string }) => {
  await mailer.send(payload.to, "Welcome!");
});
```

### 5.2 带配置 / 类型校验
```ts
import { task } from "better-trigger";
import { z } from "zod";

export const sendEmail = task({
  id: "send-email",
  schema: z.object({ to: z.string().email() }),   // 校验 + 类型推断
  retry: { max: 5, backoff: "exponential" },
  concurrency: { limit: 10, key: (p) => p.to },
  run: async (payload) => {
    await mailer.send(payload.to, "Welcome!");
  },
});
```

### 5.3 持久化步骤 + 等待(直线 async + 内联 step)
```ts
export const onboarding = task({
  id: "user-onboarding",
  run: async (payload, { step, wait, logger, now }) => {
    const user = await step("create-user", () => createUser(payload));
    logger.info("user created", { id: user.id });

    await wait.for("24h");                 // 不占 worker,到期重放
    await wait.until(payload.trialEndsAt); // 等到时间点

    await step("send-tips", () => sendTips(user));
  },
});
```

> **确定性约束**:`step` 之间的代码须确定性。需要时间/随机用 `ctx.now()` / `ctx.random()`(见 §6.3)。

### 5.4 等事件(审批 / 人机交互)
```ts
const decision = await wait.forEvent("invoice.approved", {
  match: { invoiceId: payload.id },
  timeout: "7d",   // 超时返回 null
});
if (!decision) return step("auto-cancel", () => cancel(payload.id));
```

### 5.5 触发任务
```ts
const run = await sendEmail.trigger({ to: "a@b.com" });
await sendEmail.trigger({ to: "a@b.com" }, { delay: "10m", idempotencyKey: user.id });
const result = await processVideo.triggerAndWait({ url }); // 父任务进入 wait,不占 worker
await sendEmail.batchTrigger(users.map((u) => ({ to: u.email })));
```

### 5.6 定时任务(cron)
```ts
export const dailyReport = task({
  id: "daily-report",
  cron: { pattern: "0 9 * * *", timezone: "Asia/Shanghai" },
  run: async () => { /* ... */ },
});
```

### 5.7 事件驱动(类型安全 pub/sub)
```ts
import { event, task } from "better-trigger";

export const userCreated = event<{ userId: string }>("user.created");
await userCreated.emit({ userId: user.id });

export const welcome = task({
  id: "welcome",
  on: userCreated,
  run: async ({ userId }) => { /* payload 自动推断 */ },
});
```

### 5.8 失败语义
```ts
import { task, AbortError } from "better-trigger";

run: async (payload, { step }) => {
  await step("charge", () => charge(payload));        // 抛错 = 自动按 retry 重试
  if (payload.amount <= 0) throw new AbortError("invalid amount"); // 不重试,直接失败
  await step("notify", () => notify(payload), { retry: { max: 2 } }); // 单 step 覆盖
};
```

### 5.9 step 记忆键策略
- **默认 = 执行顺序(positional)**:不强制写唯一 id,字符串只作 Dashboard 标签。
- 检测到同一 run 内调用顺序漂移时,靠**任务版本化**兜底(在途 run 锁定其启动版本)。
- (可选)允许显式 `key` 覆盖位置键,用于循环内动态步骤。

---

## 6. 持久化执行引擎

### 6.1 记忆(memoization)
每个 Run 的每个 step / wait 结果记一行 `run_step`(见 §7)。重放时按 `(run_id, seq)` 命中缓存。

### 6.2 挂起 / 恢复
- `wait.*` 与 `triggerAndWait` 通过抛出内部 `SuspendSignal` 实现"挂起"。
- Server 记录 Run 为 `waiting` + 唤醒条件(`resume_at` 或事件匹配),释放 worker。
- 编排器有一个 **timer 扫描循环**(`SELECT ... WHERE resume_at <= now() FOR UPDATE SKIP LOCKED`)把到期 Run 重新入队。

### 6.3 确定性保障
- 提供确定性替身:`ctx.now()`(重放时返回首次执行记录的时间)、`ctx.random()`(seeded)、`ctx.uuid()`。
- 提供 **ESLint 插件** `eslint-plugin-better-trigger`:在 task body 内直接使用 `Date.now()` / `Math.random()` / `new Date()` / `setTimeout` 时报错并给修复建议。
- 文档明确"副作用必须进 step"。

### 6.4 版本演进(patched)
- 每次部署 worker 注册 task 定义时带一个 `code_version`(内容哈希)。
- Run 启动时记录其 `code_version`;在途 Run 只允许由相同 `code_version` 的 worker 执行(否则等待 / 报警)。
- 远期:提供 `ctx.patched("name")` 让开发者安全演进逻辑。

---

## 7. 数据模型(Postgres)

> 用 Drizzle ORM。下面是逻辑结构,非最终 DDL。
> **多租户**:除 `tenants` 外,下面所有业务表都带 `project_id` + `environment`(或等价的 `env_id`),查询全部携带租户作用域;self-host 默认单个 default project。

- **tenants / projects / environments**:`project`(归属账号)、`environment`(`dev`/`prod`/自定义,隔离数据与 key)。
- **api_keys**:`id`、`project_id`、`environment`、`hashed_key`、`scope`(`deploy`/`trigger`/`read`)、`created_at`、`revoked_at`。
- **usage**:`project_id`、`environment`、`period`、`run_count`、`step_count`、`compute_ms`——计量埋点(不做账单)。
- **deployments(仅 SaaS)**:`id`、`project_id`、`environment`、`code_version`、`status`(`building/ready/failed`)、`artifact_url`、`tasks`(清单)、`created_at`。
- **artifacts(仅 SaaS)**:`id`、`deployment_id`、`object_key`(对象存储)、`size`、`checksum`。
- **secrets(仅 SaaS)**:`id`、`project_id`、`environment`、`name`、`ciphertext`(静态加密)、`created_at`。注入给沙箱内 worker。
- **tasks**:`id`(task id)、`type`(normal/scheduled/event)、`cron`、`event_name`、`latest_code_version`、`created_at`。
- **runs**:`id`、`task_id`、`status`(`queued|running|waiting|completed|failed|canceled`)、`payload`(jsonb)、`output`(jsonb)、`error`(jsonb)、`code_version`、`idempotency_key`、`attempt`、`created_at`、`updated_at`。
  - 唯一约束:`(task_id, idempotency_key)`。
- **run_steps**:`id`、`run_id`、`seq`(位置键)、`label`、`status`、`output`(jsonb)、`error`、`attempt`、`started_at`、`finished_at`。
  - 唯一约束:`(run_id, seq)`。
- **queue**:`id`、`run_id`、`available_at`、`locked_by`、`locked_at`、`visibility_timeout`、`priority`、`concurrency_key`。
  - 索引支持 `FOR UPDATE SKIP LOCKED` 拉取。
- **waits**:`id`、`run_id`、`kind`(`duration|until|event`)、`resume_at`、`event_name`、`event_match`(jsonb)、`status`。
- **events**:`id`、`name`、`payload`(jsonb)、`match_key`、`created_at`。
- **logs**:`id`、`run_id`、`step_seq`、`level`、`message`、`data`(jsonb)、`ts`。
- **schedules**:`id`、`task_id`、`cron`、`timezone`、`next_run_at`、`last_run_at`。
- **workers**:`id`、`code_version`/`deployment_id`、`tasks`(注册的 task id 列表)、`runtime`(`self-host`/`saas-sandbox`)、`last_heartbeat_at`、`status`。

---

## 8. Worker ↔ Server 协议(HTTP)

> v1 用 HTTP(REST + long-poll),实现简单、易穿透。后续可升级 WebSocket/SSE。
> **鉴权**:所有接口带 `Authorization: Bearer <api_key>`;server 由 key 解出 `project_id`+`environment`,所有查询限定在该租户作用域。worker 为**出站连接**;SaaS 下 worker 运行在平台 gVisor 沙箱内(同一协议)。

**部署 API(仅 SaaS,给 CLI)**:
- `POST /api/v1/deploy`:上传 bundle → 触发构建 → 返回 `deployment_id` + 构建状态。
- `GET  /api/v1/deployments/:id`:构建/发布状态。

**Worker 协议**:
- `POST /api/v1/workers/register`:上报 `code_version`/`deployment_id` + task 定义清单 → 返回 `worker_id`。
- `POST /api/v1/workers/:id/heartbeat`:心跳,带当前执行中的 run/step。
- `GET  /api/v1/dequeue?worker_id=&tasks=`:**long-poll**(挂起到有任务或超时)。返回一个待执行的 Run + 已记忆的 step 结果快照(供重放)。
- `POST /api/v1/runs/:id/steps/:seq`:上报某个 step 的结果 / 错误。
- `POST /api/v1/runs/:id/suspend`:上报挂起(wait)及唤醒条件。
- `POST /api/v1/runs/:id/complete` / `/fail`:Run 结束。
- `POST /api/v1/runs/:id/logs`:批量日志。

**可见性超时**:Worker 拿到任务后须在 `visibility_timeout` 内心跳;超时未心跳 → server 认为 worker 挂了,任务回队重试。

**触发 API(给应用代码 / 外部系统)**:
- `POST /api/v1/trigger`:`{ taskId, payload, options }` → 返回 `runId`。
- `POST /api/v1/events`:发射事件。

---

## 9. 队列、重试、调度、并发

- **队列**:Postgres 表 + `SELECT ... FOR UPDATE SKIP LOCKED LIMIT N`。支持 `available_at`(延迟)、`priority`。
- **重试**:默认指数退避 `delay = base * 2^attempt`(带 jitter),`max` 可配。step 级可覆盖。`AbortError` 不重试。
- **cron 调度**:编排器扫描 `schedules.next_run_at <= now()`,创建 Run 并计算下一次 `next_run_at`(支持 timezone)。
- **并发控制**:`concurrency.limit` + `concurrency.key`。dequeue 时按 key 统计 running 数,超限的任务跳过(留在队列)。

---

## 10. Dashboard

技术栈:React + Vite + TailwindCSS + shadcn/ui + Lucide。

页面:
- **Tasks**:所有已注册任务,类型、最近运行状态、成功率。
- **Runs**:运行列表,按 task/状态/时间筛选。
- **Run 详情**:时间线(每个 step / wait 的状态、耗时、输入输出)、日志流、错误堆栈、payload/output、当前 `waiting` 的唤醒条件。
- **操作**:手动触发(填 payload)、重试失败的 Run、取消 `waiting`/`queued` 的 Run、发射测试事件。
- **Workers**:在线 worker、code_version、心跳。
- **Schedules**:cron 任务及下次触发时间。
- **Deployments(仅 SaaS)**:部署历史、构建日志、code_version、回滚。
- **Secrets(仅 SaaS)**:环境变量/密钥管理(只写不读回明文)。

---

## 11. 托管算力 SaaS

> 目标:**同一套引擎同时跑 self-host(轻)与托管算力 SaaS(重)**。SaaS 下平台构建并在 gVisor 里跑用户代码。

### 11.1 代码投递与构建
- CLI `better-trigger deploy`:本地 **esbuild bundle** → 上传制品 → 服务端生成可运行镜像/制品 → 存对象存储。
- 每次部署产生一个 `deployment` + `code_version`(内容哈希);支持回滚。
- 在途 run 锁定其启动 `code_version`(配合 §6.4 版本演进)。

### 11.2 隔离(gVisor)
- 每个 run 在 **gVisor(runsc)** 沙箱里跑 worker:拦截 syscall,近 VM 隔离、容器级启动速度。
- 隔离粒度:默认 **每租户热池**(同租户复用,跨租户绝不复用);高敏感可配每-run 一次性环境。
- 资源限制:CPU/内存/执行超时/出网策略逐租户可配。
- 远期:更强隔离可升级 Firecracker microVM(接口预留)。

### 11.3 计算编排
- 编排器按队列需求拉起/复用沙箱 worker(热池减冷启动),加载该租户制品与注入 secrets。
- wait 挂起时释放沙箱(不占资源),到期重新调度(重放)。
- 自动扩缩容:按 project/env 的 `concurrency` 与队列深度。

### 11.4 租户与 API key
- 层次:`account → project → environment(dev/prod/…)`;业务表全带作用域,self-host 默认单租户。
- key `scope`:`deploy`(CLI 部署) / `trigger`(应用调 trigger) / `read`(Dashboard)。仅存哈希,可轮换。

### 11.5 密钥托管
- 既然平台跑代码,用户环境变量/密钥存平台(`secrets`,静态加密),运行时注入沙箱。
- Dashboard 只写不读回明文;访问审计。

### 11.6 计量(不做账单)
- 埋点 `run_count` / `step_count` / `compute_ms` / wait 时长 → `usage`。仅供展示与配额,v1 不接入支付。

### 11.7 安全要点(跑不可信代码)
- gVisor 沙箱 + 跨租户不复用 + 资源/出网策略 + 制品扫描。
- 租户隔离、key 最小权限、secrets 加密、审计日志。
- **这是本项目最重的安全面**:托管算力意味着跑不可信多租户代码,需持续投入。self-host 不涉此(只跑自己代码)。

---

## 12. 技术栈与项目结构

- **语言**:TypeScript(全栈)。
- **Server**:Hono(轻量、跨运行时)。
- **DB 访问**:Drizzle ORM(Postgres)。
- **SDK**:零运行时依赖核心 + 可选 zod peer。
- **Dashboard**:React + Vite + Tailwind + shadcn/ui。
- **Monorepo**:pnpm workspaces + turborepo。

```
better-trigger/
├── packages/
│   ├── sdk/          # task/step/wait/trigger + 重放运行时(worker 端)
│   ├── server/       # Hono API + 编排器 + 队列 + Drizzle schema
│   ├── builder/      # (SaaS) deploy 接收 + esbuild 打包 + 制品生成
│   ├── orchestrator/ # (SaaS) gVisor 沙箱调度 + 热池 + 自动扩缩容
│   ├── dashboard/    # React 前端
│   ├── cli/          # better-trigger dev / deploy / migrate
│   └── core/         # 共享类型、协议、错误
├── examples/
├── docker-compose.yml
└── PRD.md
```

部署形态:
- **self-host(轻)**:`docker compose up`(server + Postgres)+ 用户跑 worker。不含 builder/orchestrator/对象存储。
- **托管算力 SaaS(重)**:server + Postgres + builder + orchestrator(gVisor 节点池)+ 对象存储(S3/MinIO)。
- SaaS 需支持 gVisor 的主机(runsc 运行时)。

---

## 13. 里程碑

### M0 — 骨架
- monorepo、core 类型/协议、Drizzle schema + migration、Hono server 起步。
- 租户模型与 API key 骨架(self-host 默认单租户)。

### M1 — 最小可用核心(MVP)
- `task()` 定义 + worker long-poll 执行。
- 内联 `step()` + 重放 + 记忆。
- `trigger()` + 队列(`SKIP LOCKED`)+ 重试。
- 最简 Dashboard:Runs 列表 + 详情 + 日志。
- `docker compose up` 可跑通端到端示例。

### M2 — 等待与调度
- `wait.for / wait.until` + 挂起/恢复(timer 扫描)。
- cron 调度。
- `triggerAndWait` / `batchTrigger`。
- 并发控制。

### M3 — 事件与体验
- `event()` + `wait.forEvent` + 事件触发任务。
- `ctx.now()/random` + ESLint 插件。
- 幂等键、Dashboard 操作(重试/取消/手动触发)、Workers 页。
- CLI(`dev`/`migrate`)。

### M4 — 托管算力 SaaS(重点)
- CLI `deploy`:esbuild 打包 + 上传;builder 生成制品 + 对象存储。
- orchestrator:**gVisor 沙箱**调度 + 热池 + 资源限制 + 自动扩缩容。
- secrets 托管 + 注入;deployments/secrets Dashboard 页;多租户全链路。
- 版本演进 `patched()` + 部署回滚。

### M5 — 打磨与远期
- 计量/配额、可观测性增强、metrics。
- 数据端到端加密选项。
- (远期可选)Firecracker microVM 更强隔离。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 重放确定性被违反 → 难排查 bug | `ctx.now()/random` + ESLint 强约束 + 文档;Dashboard 展示重放轨迹 |
| 重放开销随 step 数增长 | 单 Run step 数建议上限 + 文档;超大流程引导拆分/任务链 |
| 代码改动导致在途 run 漂移 | code_version 锁定 + patched();部署时灰度 |
| Postgres 作队列在超高并发下成瓶颈 | `SKIP LOCKED` + 索引优化;远期可选分区/外部队列适配器 |
| long-poll 在大量 worker 下连接数高 | 连接复用;远期升级 SSE/WebSocket |
| 用户 step 非幂等 + 重试 → 副作用重复 | 文档强调 step 幂等;提供 idempotencyKey 工具 |
| SaaS:payload/输出明文存在平台引发隐私顾虑 | 提供端到端加密选项;强调 self-host 选项;最小化存储 |
| 多租户隔离遗漏 → 跨租户泄露 | 所有查询强制作用域 + 集成测试;远期 Postgres RLS |
| **沙箱逃逸**(跑不可信代码) | gVisor + 跨租户不复用 + 资源/出网策略;远期 Firecracker;安全持续投入 |
| 托管算力拉高运维/成本 | self-host 保持轻(不含这些);SaaS 热池复用减成本 |
| 平台托管密钥的泄露风险 | secrets 静态加密 + 最小权限注入 + 审计;可选外部 KMS |
```
