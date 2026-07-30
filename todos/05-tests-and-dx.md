# 05 — 测试 / CI / 开发体验

## T1 · 没有 CI,也没有测试框架 —— 验收无法重跑 {#t1}

**位置** 不存在 `.github/`;`turbo.json` 只有 `build` / `dev` / `lint` /
`typecheck`,**没有 `test`**;全仓没有 vitest / jest / `bun test` 的任何依赖或脚本

**现象** 现有的正确性保障是 `examples/basic/scripts/` 下 5 个手写脚本
(e2e 526 行、fencing 463 行、replay-drift 299 行、crash 247 行、
worker-lost 208 行,合计约 1750 行),靠 `bun scripts/e2e.ts` 手动执行,
需要一个活着的 Postgres。`docs/architecture.md:150` 记录了"验收(已跑通,50 项)"。

**影响** 这是整个项目**最大的风险面**。那 50 项验收覆盖的正是最难写、最有价值的
东西(SIGKILL 下 step 恰好一次、fencing 拒绝迟到写、worker 丢失后接管),
但它们:

- 不在任何自动化流程里 —— 改一行 `runs.ts` 没有任何东西会告诉你 fencing 破了;
- 没有断言框架,失败信息靠脚本自己 `console.log`;
- 每个脚本各自建 pool、起 daemon、造数据,互相复制粘贴。

后果是 `docs/architecture.md` 的 P2(fingerprint、fault injection、不变量断言)
建立在一个没有测试基座的地方 —— 那些工作的前置条件就是这条。

**建议** 按这个顺序做:

1. **让现有验收可重跑**:根 `package.json` 加
   `"test:acceptance": "turbo run test:acceptance"`,examples/basic 里把 5 个脚本
   串成一个入口,退出码反映结果(现在部分脚本是靠人读输出的)。
2. **GitHub Actions**:`postgres:16-alpine` 作为 service container,跑
   `build → typecheck → test:acceptance`。这一步就把那 50 项从"曾经跑通过"
   变成"每个 PR 都跑"。
3. **引入 vitest**,把纯函数先覆盖掉 —— `computeBackoffMs`、`parseDuration`、
   `resolveRetryPolicy`、`normalizeCron`、`nextCronAt`、`loadTasks`、
   `resolveCodeVersion`、HTTP 客户端的错误映射(`client.ts:132-148`,可以用
   注入的 fetch 测,不需要 DB)。这些是零成本高价值的部分。
4. **抽 harness**(见 [T8](#t8))之后,把 5 个脚本改写成 vitest 用例,
   P2 的 fault injection 就有地方挂了。

---

## T2 · `core` 的"零运行时依赖"是硬约束,但没有自动校验 {#t2}

**位置** `docs/architecture.md:81`("**它必须保持零运行时依赖**")、
`packages/core/package.json`(目前确实只有 devDependencies)

**现象** 这条约束是整个客户端/daemon 分离方案的地基 —— core 在 SDK 的依赖路径上,
core 一旦拖进 `pg`,`better-trigger` 就又变成"装一个包顺带装数据库驱动"。
现在只靠人记着。

**建议** CI 里加一条断言(几行 node 脚本即可):`packages/core/package.json` 的
`dependencies` 必须为空或不存在;`packages/sdk` 的 `dependencies` 只允许
`@better-trigger/core`。顺手加 `publint` + `@arethetypeswrong/cli` 检查
`sdk` / `core` 的产物导出映射(双 ESM/CJS + `./internal` 子路径导出,
这是最容易在发布后才发现坏掉的地方)。

---

## T3 · 缺 `LICENSE` 文件 {#t3}

**位置** 仓库根;`packages/sdk/package.json` 已声明 `"license": "MIT"`

**影响** 声明了 MIT 但没有许可证正文,发到 npm 之后法律上是含糊的,
也会被一些依赖审查工具标红。

**建议** 补根目录 `LICENSE`(MIT 正文),并给其余 package.json 补
`license` / `repository` / `homepage` 字段(目前只有 sdk 有 license)。

---

## T4 · 非法 JSON body 返回 500 而不是 400 {#t4}

**位置** `apps/worker/src/routes/trigger.ts:23`、`:35`、
`apps/worker/src/routes/dashboard.ts:319`

**现象** 直接 `await c.req.json<T>()`。body 不是合法 JSON 时抛 `SyntaxError`,
不是 `KernelError`,于是走 `app.onError` 的兜底分支 → **500 internal_error**
(还会 `console.error` 一条"unhandled error",污染日志)。

**影响** 客户端的错误被报告成服务端的错误。调试时会往错误的方向找。

**建议** 一个 `safeJson<T>(c)` helper:catch 之后抛
`new KernelError('bad_request', 'request body must be valid JSON')`,
现有的 `STATUS_BY_CODE` 映射(`app.ts:24-31`)会自动给出 400。所有读 body 的
路由都换成它。

---

## T5 · `PATCH /schedules/:id` 不校验 body {#t5}

**位置** `apps/worker/src/routes/dashboard.ts:317-338`

**现象** `body.enabled` 直接进
`UPDATE schedules SET enabled = $2 ...`。`{}` 会让它变成 `undefined` → pg 传
NULL → 违反 `enabled` 的 NOT NULL(`schema.ts:183`)→ 500。

**建议** `typeof body.enabled !== 'boolean'` 就抛 `bad_request`。
这条和 [T4](#t4) 一起做 —— 顺便看一眼所有路由的 body/query 是否都有类型校验
(kernel 层的 `trigger` / `batchTrigger` 校验做得不错,可以作为参照)。

---

## T6 · `ctx` 没有 AbortSignal,长 step 无法被取消 {#t6}

**位置** `apps/worker/src/executor.ts:259-264`(`checkCanceled`,只在 step 边界)、
`packages/sdk/src/context.ts:59-78`(`RunCtx` 表面)

**现象** 取消通过 heartbeat 传进来(`runtime.ts:112-114` → `markCanceled()`),
但只在**下一个 durable primitive 边界**才生效。已经开始执行的 step fn 会跑到底。

**影响** agent 场景里 step 就是"一次 LLM 调用"或"一次工具调用",可能几十秒到
几分钟。用户在 dashboard 点了取消,却要等当前 step 跑完 —— 而这个 step 的输出
马上就会被丢弃。关停时同理:`SHUTDOWN_DRAIN_MS`(30s)白等一个注定要作废的调用。

**建议** `ctx.signal: AbortSignal`,在以下时刻 abort:heartbeat 报告取消、
worker 开始关停、[C2](01-correctness.md#c2) 的 lease 丢失检测触发。用户把它传给
`fetch` / SDK 就能立刻中断。这是个纯增量的 API,不破坏现有语义,而且对
"P5 agent 层"是刚需 —— 建议排在 P3 之前。

---

## T7 · `apps/web` 手写重复了 core 的类型 {#t7}

**位置** `apps/web/src/types.ts`(97 行)+ `apps/web/src/api/adapter.ts`(342 行)

**现象** dashboard 自己声明了一套 `RunSummary` / `RunDetail` / `StepKind` …,
再用 adapter 层把 API 响应映射过去。而这些形状在
`packages/core/src/types.ts` 和 `apps/worker/src/types.ts` 里已经有了。

**影响** 同一个契约有三份声明。加一个 run 状态或 step kind 要改三处,漏一处就是
静默的运行时不一致(TS 不会报错,因为它们是各自独立的字面量联合)。

**建议** 让 web 直接 `import type` `@better-trigger/core`(它零依赖,进浏览器
没有负担),adapter 只保留真正需要的转换(比如 null → undefined 的规整),
不再重新声明形状。

---

## T8 · 验收脚本缺共享 harness {#t8}

**位置** `examples/basic/scripts/`(5 个脚本 + 3 个 task 变体模块,约 1750 行)

**现象** 每个脚本各自:建 pool、清库、spawn daemon、轮询等状态、
`console.log` 结果。`crash.ts` 和 `worker-lost.ts` 的 daemon 启动/杀死逻辑
基本是复制粘贴的。

**影响** 加一个新场景的成本很高,所以就不加了 —— 这直接拖住了 P2 的
fault-injection suite(它的形态就是"在每个持久化边界注入故障",也就是同一个
harness 跑几十遍)。

**建议** 抽 `packages/testing`(`docs/architecture.md:133` 已经规划了这个包):
`withDaemon({ tasks, env })`、`waitForStatus(runId, status, timeout)`、
`killDaemon(signal)`、`resetDb()`、以及几个不变量断言
(`assertSeqContiguous(runId)`、`assertNoStepRewrites(runId)`、
`assertTerminalImmutable(runId)`)。这个包同时也是 P2 虚拟时间的落点。
