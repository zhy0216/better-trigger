difficulty: medium

# 07 · worker runtime / executor 硬化

覆盖 `apps/worker` 的 executor、runtime 库 API、observability、静态资源与打包配置。与 06 文件不相交（06 负责路由/中间件/CLI/waiters），可并行。

## T1 · 确定性参数错误不得消耗重试预算（P2）

- 做什么：`executor.ts:430-431` 的 `ctx.wait` 包装器在 `doWait`/`beginPrimitive` 之前求值：非法时长抛 `Error('invalid duration…')`（core/duration.ts:43,51）或 `KernelError('bad_request')`（duration.ts:64），非法 Date 的 `toISOString()` 抛 `RangeError`。这些落进 `handleThrown`（`executor.ts:347-369`），只有 `isAbortError(err)` 决定是否可重试 → 确定性失败被挂上 `this.task.retry`，每次重放相同失败、烧完预算后才到同样的终态。这与执行器自己的教条冲突——`isUnfixableKernelError`（`executor.ts:94-107`："bad_request 重试无意义，必须确定性终止"）只用在 kernel 调用的 catch 块里，没覆盖步骤之间抛出的错。修法：在 `handleThrown` 里分类——`abort = isAbortError(err) || isUnfixableKernelError(err)`（或把包装器参数错误在边界转成 `AbortError`）。
- 预计文件：`apps/worker/src/executor.ts`、`apps/worker/test/`（新增：`ctx.wait.for('bogus')` / `ctx.wait.until(new Date('x'))` 使 run 非重试失败，断言尝试次数=1）。
- 验收：新测试钉住确定性参数错误不重试；既有重试/中止语义测试全绿。
- 前置依赖：无。

## T2 · startWorkerRuntime 库 API 补校验（P2）

- 做什么：`runtime.ts:134-178` 的公开导出 `startWorkerRuntime`（`index.ts:14`）不做任何校验：`leaseMs < 1500` 被接受（正是 p1-16 防的故障——租约早于首次 `max(500, leaseMs/3)` 续约，reaper 吃掉活 run 的恢复预算）；`concurrency <= 0` → 零 claim 循环；空 `tasks`/`namespaces` → 无限节流的 claim 错误循环。CLI（`requireLeaseMs`）与 embedded host（`embedded.ts:213-232`）各自校验，库路径裸奔。在 `startWorkerRuntime` 顶部统一校验（lease 下限、正整数 concurrency、≥1 task、≥1 namespace），抛清晰错误。CLI/embedded 保留既有校验不动（避免与 06 的 cli.ts 冲突；收敛为单一入口属后续重构，不在本条）。
- 预计文件：`apps/worker/src/runtime.ts`、`apps/worker/test/`。
- 验收：非法入参在 `startWorkerRuntime` 入口即抛错并点名参数；合法路径不变；新增测试。
- 前置依赖：无。

## T3 · 背压告警不再打印字面 "undefined"（P2）

- 做什么：`executor.ts:1127-1133` 日志缓冲溢出路径调 `d.log.warn('log-flush:backpressure', …, undefined)`；`observability.ts:58` `createThrottledLogger.warn` 总是追加 `describeError(err)`，`describeError(undefined)` = `String(undefined)` → 每条背压日志末尾挂一个多余的 `undefined`。修法：`describeError` 对 `undefined` 返回 `''`（且调用端跳过第二参数），或调用点改传真值。
- 预计文件：`apps/worker/src/observability.ts`、`apps/worker/src/executor.ts`（若改调用点）、测试。
- 验收：背压日志参数无字面 "undefined"；`describeError` 对 undefined/null 有测试。
- 前置依赖：无。

## T4 · 静态资源流式响应（P2）

- 做什么：`static.ts:219-220` `serveFile` 用 `await readFile(target)` 整体缓冲再应答——大型哈希 JS 包的每次冷取按并发数全额分配，且无 `Range`。改为 `createReadStream` → `Readable.toWeb(...)` 流式应答（有界内存）；`Range` 支持可选做，不做则在注释说明理由（哈希资产被客户端 `immutable` 缓存，紧迫度低）。
- 预计文件：`apps/worker/src/static.ts`、`apps/worker/test/`（静态托管套件回归：内容一致、Content-Length 正确）。
- 验收：既有静态托管测试全绿；响应体与文件内容一致；并发请求下不再整文件缓冲（以流实现为准）。
- 前置依赖：无。

## T5 · 打包与工程小修（P2）

- 做什么：
  - `tsdown.config.ts` banner 给**所有** bundle 注入 `#!/usr/bin/env node`（只有 `main.js` 是 bin）——仅对 bin 入口注入。
  - `apps/worker/package.json` `engines.node >=20` 与 `tsdown` `target: 'node18'` 不一致——统一到实际支持的下限并注释。
  - `runtime.ts:527-530` 经 `globalThis.process` cast 读 env，其余模块直接 `process.env`——统一。
- 预计文件：`apps/worker/tsdown.config.ts`、`apps/worker/package.json`、`apps/worker/src/runtime.ts`。
- 验收：构建产物中仅 `main.js` 带 shebang；typecheck/build 全绿。
- 前置依赖：无。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`。
