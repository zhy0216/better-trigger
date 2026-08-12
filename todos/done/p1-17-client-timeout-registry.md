# P1-17 — HTTP 客户端三处合同缺口:超时误报"daemon 没起"、预中止 signal 失效、registry 无版本校验

- 优先级:P1(SDK 可诊断性/健壮性)
- 区域:sdk
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#17)

## 现状

1. **超时错误歧义**:`packages/sdk/src/client.ts:141-150` 的 catch 只识别**调用方**的 `signal?.aborted`;内部超时 abort(`:125`)落进通用分支,报 `request to … failed (This operation was aborted) — is the worker daemon running?`,且与 ECONNREFUSED/DNS 同为 `status 0, code null`,程序上无法区分。`test/client.test.ts:250-262` 只断言 `status === 0`,恰好锁定了这个歧义。更要命的组合:`POST /trigger` 超时后 run 可能**已经创建**,而文档从未把 `idempotencyKey` 与这个恢复场景关联。
2. **预中止 signal**:`client.ts:127` 只 `signal?.addEventListener('abort', …)`,没有 `if (signal.aborted)` 前置检查——已触发过的 signal 不会再 dispatch,请求照发。且公开 API(`BetterTriggerOptions`/`WaitForResultOptions`)根本没暴露 signal,`RequestOptions.signal`(`client.ts:74`)是无人可达的死缝。另:`instance.ts:172-180` 的 `result()` 在无 resolver 时**同步 throw** 而不是 reject,与其他方法不一致。
3. **registry 无校验**:`registry.ts:28-39` 注释称 "Versioned so an incompatible future shape cannot silently adopt this one",实现是 `g[KEY] ??= {…}`——无 shape 检查、无版本戳。两个不同版本的 SDK 副本共槽时,新版代码读旧对象的新字段得 `undefined`,症状是莫名的 "must be called inside a running task" 或 `setDefault()` 无效,毫无指向性。

## 实现方案

1. 超时判别:`request()` 里记录内部定时器是否触发;是则抛 `HttpError(0, 'timeout', 'request to … timed out after <N>ms')`(code 字段从 null 变 'timeout',属于可加字段不破坏现有判断)。文档(sdk README 的错误小节)写明:超时的 `trigger()` 结果不确定,配 `idempotencyKey` 可安全重发。
2. AbortSignal 打通:`signal?: AbortSignal` 加入 `WaitForResultOptions` 与各公开方法的 options,穿透到 `request()`;`request()` 开头 `if (signal?.aborted) throw` 前置检查;listener 记得 removeEventListener 防泄漏。`instance.ts:172-180` 改为返回 rejected promise。
3. registry 校验:对象加 `{ v: 1, sdkVersion }` 戳;`??=` 改为显式 adopt 函数——存在旧对象时校验必需键与 `executorStorage` 形状,`sdkVersion` 不一致打一条 `console.warn`(点名两个版本与"duplicate better-trigger copies");必需键缺失时抛错点名根因。与 p1-16 的惰性 ALS 改动同文件,相邻实施。
4. 更新 `client.test.ts:250-262`(区分 timeout code)与 `:197-209`(用真实 AbortController 而非 stub throw,验证预中止确实拦下请求)。

## 验收标准

- 测试:内部超时 → `code === 'timeout'` 且文案含毫秒数;ECONNREFUSED → code null 文案维持 "is the worker daemon running?"。
- 测试:预中止 signal 下 fetch 从未被调用;等待中 abort → 请求中断、错误可识别。
- 测试:模拟两副本(vi.resetModules 二次 import)共享 registry——同版本静默共享,版本戳不一致产生 warn;缺键对象被拒绝。
- `result()` 无 resolver 时返回 rejected promise(await 可 catch)。

## 涉及文件

- `packages/sdk/src/client.ts:74`、`:125-150`
- `packages/sdk/src/instance.ts:172-180`(+ 各方法 options)
- `packages/sdk/src/registry.ts:28-39`
- `packages/sdk/test/client.test.ts`、`packages/sdk/README.md`
