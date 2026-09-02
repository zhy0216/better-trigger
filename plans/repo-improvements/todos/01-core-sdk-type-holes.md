difficulty: medium

# 01 · core/sdk 类型洞与校验边界

本文件全部位于 `packages/core` 与 `packages/sdk`，与其他 todo 文件不相交。

## T1 · serializeError 改为全函数（P1）

- 做什么：`packages/core/src/errors.ts:116-121` 的 `serializeError` 对非 Error 值裸调 `JSON.stringify`：throw 含 BigInt/循环引用的值会在失败上报路径内抛 `TypeError`（worker executor `handleThrown` → `failRun` 崩出执行器，run 烧 recoveries 预算，最终以误导性 WorkerLostError 收场）；`throw undefined`/Symbol/函数时 `JSON.stringify` 返回 `undefined` → `{ message: undefined }` 违反 `SerializedError.message: string`。修法：`JSON.stringify` 包 try/catch，失败回退 `String(err)` 或 `"non-serializable thrown value: <String(err)>"`；`message` 强制保证为 string。参照同包 `serialize.ts` 的 "never throws" 原则。
- 预计文件：`packages/core/src/errors.ts`，`packages/core/test/`（新增测试）。
- 验收：新增单测覆盖：循环对象、BigInt、`undefined`、Symbol、函数、普通字符串、普通对象 → 全部返回 `message: string` 且不抛；现有测试全绿。
- 前置依赖：无。

## T2 · task() 校验 concurrency.limit（P1）

- 做什么：`packages/sdk/src/task.ts:250-262` `normalizeDefinition` 校验了 retry/replay 但不校验 `concurrency.limit`；`limit: 0`/负数直落 `tasks.concurrency_limit`，内核 `queue.ts:476` 的 `if (running >= limit) return null` 使该任务永久不可调度且无任何报错。在 `normalizeDefinition` 中拒绝非正整数的 `concurrency.limit`（抛 `KernelError('bad_request')`，消息点名 task id，仿 `validateRetryPolicy` 模式）。
- 预计文件：`packages/sdk/src/task.ts`，`packages/sdk/test/`。
- 验收：`limit: 0` / `-1` / `2.5` / `NaN` 在定义期抛 bad_request；合法值不变；新增单测钉住。
- 前置依赖：无。

## T3 · 收窄 batchTrigger 批级 options（P1）

- 做什么：`packages/sdk/src/instance.ts:115` 与 `packages/sdk/src/task.ts:98-101` 的批级 `options` 类型为完整 `TriggerOptions`，但服务端只取 namespace（`apps/worker/src/routes/trigger.ts:44`）——`delay`/`priority`/`idempotencyKey`/`concurrencyKey` 编译通过后被静默丢弃。把两处签名收窄为 `Pick<TriggerOptions, 'env' | 'projectId'>`（批级注释已写明 "projectId / env only"）。
- 预计文件：`packages/sdk/src/instance.ts`、`packages/sdk/src/task.ts`、sdk 类型/单测。
- 验收：`@ts-expect-error` 类型测试钉住批级传 `delay`/`priority` 编译失败；运行时行为不变；`check:exports` 通过。
- 前置依赖：无。

## T4 · 收窄 triggerAndWait options（P2）

- 做什么：`packages/sdk/src/task.ts:112` 与 `packages/sdk/src/context.ts:113-117` 的 `triggerAndWait` 仍收完整 `TriggerOptions`：`idempotencyKey` 编译通过但内核以 bad_request 拒绝 → 执行器判不可修复 → 整个父 run 终态失败；`env`/`projectId` 编译通过但被 warn 剥离。改为 `Omit<TriggerOptions, 'idempotencyKey' | 'env' | 'projectId'>`（运行时剥离保留作纵深防御）。
- 预计文件：`packages/sdk/src/task.ts`、`packages/sdk/src/context.ts`、类型测试。
- 验收：类型测试钉住三者编译失败；现有运行时剥离测试仍通过。
- 前置依赖：无。

## T5 · waitForResult 参数硬化（P2）

- 做什么：`packages/sdk/src/instance.ts:438` `timeoutMs` 无校验：`NaN` → deadline 为 NaN → `Date.now() >= NaN` 恒假 → 每 ~5s 永久轮询（与 `HttpClient.assertTimeoutMs` 的既有哲学相悖）；小数 `timeoutMs`（如 250.5）使 `:449-450` 的 `slice` 为小数，服务端 `intQuery` 判为垃圾值回退 5s 长轮询 → 预算超支 ~20×，修法是 `Math.floor(slice)`；`instance.ts:292-299` `isNamespace` 要求 projectId+env 同时为 string，`waitForResult('run_1', { projectId: 'acme' })` 这类半吊子对象落入 opts 槽、静默轮询 default/prod —— 改为：对象含其一（字符串）但缺另一时抛配置错误。若保留 `Infinity` 语义（等待无期限），显式写进 doc 注释。
- 预计文件：`packages/sdk/src/instance.ts`、sdk 单测。
- 验收：`timeoutMs: NaN/0/-1` 抛错；小数预算取整后请求参数为整数；半吊子 namespace 抛错并点名缺失字段；新增单测钉住。
- 前置依赖：无。

## T6 · 429 rate_limited 归为可重试（P2）

- 做什么：`packages/sdk/src/instance.ts:338-341` `isRetriable` 对所有 `KernelError` 返回 false，但 `rate_limited`（429，READ 桶覆盖 `/runs/:id/result`）按定义是瞬态——`result()` 在限流下立即失败而非退避重试。在 `isRetriable` 中把 `rate_limited` 特判为可重试（退避机制已存在）。
- 预计文件：`packages/sdk/src/instance.ts`、单测。
- 验收：模拟 429 → 重试后成功路径的测试；其余 KernelError 仍不可重试。
- 前置依赖：无。

## T7 · client headers 大小写不敏感合并（P2）

- 做什么：`packages/sdk/src/client.ts:77-78` 文档说调用方 headers "merged over the defaults"，实现（`:163-165`）却是默认值后写覆盖同名键；调用方传小写 `'content-type'` 时两个键并存，fetch 归并后触发服务端 `requireJsonContentType` 400。改为大小写不敏感合并（用 `Headers` 或统一小写决定胜负）；明确并注释语义：Authorization 不允许调用方覆盖，Content-Type 允许覆盖。
- 预计文件：`packages/sdk/src/client.ts`、单测。
- 验收：小写 `content-type` 覆盖生效且请求头无重复；`authorization` 覆盖被忽略；注释与行为一致；新增单测。
- 前置依赖：无。

## T8 · 204 类型洞显式化（P2）

- 做什么：`packages/sdk/src/client.ts:183` `return undefined as T` 是泛型谎言。拆出 `requestEmpty(...)`（204 路径专用，返回 `Promise<void>`）或至少改为显式 `undefined as unknown as T` + doc 注释"204 调用必须用 void/unknown"。`cancelRun` 改用新路径。
- 预计文件：`packages/sdk/src/client.ts`、（如有必要）调用方。
- 验收：typecheck 通过；无行为变化；注释/签名自洽。
- 前置依赖：无。

## T9 · 补齐 sdk 公开导出（P2）

- 做什么：`packages/sdk/src/index.ts:23-78` 缺：`isExecutionEndedSignal`（兄弟谓词与 `ExecutionEndedSignal` 类型均已导出，独缺品牌检查值）；用户签名需要的类型 `Namespace`、`RetryRunOptions`、`BatchItemOptions`、`BatchTriggerItem`（目前用户只能摸 `@better-trigger/core` 或 `Parameters<>`）。补 re-export。
- 预计文件：`packages/sdk/src/index.ts`。
- 验收：`check:exports`（publint + attw）通过；从包根可 import 上述符号。
- 前置依赖：无。

## T10 · 删除死代码（P2）

- 做什么：`packages/sdk/test/lifecycle-selftest.ts` 驱动的是 pre-split API（`betterTrigger({ database })`、`instance.start()` 等），已从 typecheck 与 vitest 双排除，首行即挂——删除。`packages/sdk/src/task.ts:276-290` 与 `instance.ts:365-369` 的 concurrency-key 推导重复，收敛为单一 helper。`packages/core/src/serialize.ts:94-96` `byteLength` 每次新建 `TextEncoder`，提升为模块级单例。
- 预计文件：`packages/sdk/test/lifecycle-selftest.ts`（删）、`packages/sdk/src/task.ts`、`packages/sdk/src/instance.ts`、`packages/core/src/serialize.ts`。
- 验收：删除后 typecheck/test 全绿；并发键推导单一路径且行为不变（既有测试钉住）。
- 前置依赖：无。

## T11 · 补缺失测试（P2）

- 做什么：补以下无测试的关键路径：`assertNamespace`（`packages/core/src/namespace.ts:41-62`，64 字符上限、禁 `:` 因 advisory-lock 键）；`isAbortError` 跨 realm 分支；`triggerAndWait` 在 run 外调用的报错路径（`task.ts:353-359`）；`retryRun` 发 `Idempotency-Key` 头（`instance.ts:394-402`）；`betterTrigger()` 的 `BETTER_TRIGGER_URL`/`BETTER_TRIGGER_API_KEY` env 默认（`instance.ts:258-261,348-351`）。
- 预计文件：`packages/core/test/`、`packages/sdk/test/` 新增测试文件。
- 验收：上述路径各至少一个测试；套件全绿。
- 前置依赖：T1、T4 先行（避免同文件冲突）。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test && bun run check:exports`。
