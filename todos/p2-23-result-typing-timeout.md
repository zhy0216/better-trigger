# P2-23 — `handle.result()` 无类型参数;30s 默认超时静默返回非终态而 README 当终态示例

- 优先级:P2(DX/文档,"Type-safe" 卖点的缺口)
- 区域:sdk / core
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」P2)

## 现状

- `packages/sdk/src/instance.ts:29-40`:`RunHandle` 非泛型,`result(): Promise<WaitResult>`;`core/types.ts:385-389` 的 `WaitResult` 也非泛型(`output?: unknown`)。`TaskHandle<TPayload, TOutput>` 的 `TOutput` 只到达 `triggerAndWait`(`task.ts:55` vs `:67`)——`trigger()` 返回的 handle 丢掉了输出类型。
- 默认预算 30s(`instance.ts:287`);到期时服务端返回**最新非终态**(`waiters.ts:134-139`),循环把它当正常值返回(`:306`)——不抛错、`output === undefined`。`README.md:81` 的 `console.log(await handle.result())` 按"总是终态"展示;sdk README(`:121`)只说 "Wait for a terminal state"。

## 影响

"Type-safe durable task orchestration" 的包里 `const { output } = await handle.result()` 是 `unknown`,人人手写 cast。任何 >30s 的任务,首跑体验是拿到 `{ status: 'running' }` 而无任何异常——按 README 的示例写代码的人会把非终态当结果用。

## 实现方案

1. 泛型化:`WaitResult<T = unknown>`(output 收窄为 `T | undefined`)、`RunHandle<TOutput = unknown>`;`TaskHandle.trigger` / `batchTrigger` 返回 `RunHandle<TOutput>`;`instance.waitForResult` 相应带泛型。默认参数保证对既有代码零破坏。
2. 超时语义二选一并文档化(推荐 a):
   - a. `result({ throwOnTimeout: true })` 可选参数,超时抛 `ResultTimeoutError`(带最新 status);默认行为不变但 README/sdk README 明确写出"超时返回最新非终态,判 `status` 后自行处理";
   - b. 直接把超时改为抛错(破坏性,需在 CHANGELOG 标注)。
3. README 的 quick-start 示例改为演示对 `status` 的判断或加一句说明,不再暗示恒为终态。
4. 类型测试(expect-type):`hello.trigger(...)` 的 result output 推导为任务返回类型。

## 验收标准

- 类型测试通过;现有 JS/TS 消费代码零破坏(默认泛型)。
- `throwOnTimeout` 行为有单测;README 示例与实际语义一致。
- `check:exports` 通过。

## 涉及文件

- `packages/core/src/types.ts:380-389`
- `packages/sdk/src/instance.ts:29-40`、`:286-308`;`packages/sdk/src/task.ts:55,61,67`
- `README.md:71-82`、`packages/sdk/README.md:121`
