# P2-36 — `packages/sdk/src/instance.ts` 324 行零单测;registry 跨副本共享(它存在的唯一理由)无测试

- 优先级:P2(测试盲区,SDK 侧收口)
- 区域:sdk
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」SDK 覆盖盲区)

## 现状

- `instance.ts` 无任何 `instance.test.ts`;唯一覆盖是要真 Postgres 的验收脚本。未测:`waitForResult` 续期切片(多跳对 `MAX_LONGPOLL_MS` 的切分、deadline 运算、最后一跳 `slice === 0` 的立即读)、终态 vs 超时返回、`nsFromOptions`/`nsQuery` 的 namespace 传播、`trigger()` 从 `taskOrId.__definition` 派生并发键、`makeRunHandle` 的 resolver 优先级(`instance ?? resultResolver ?? defaultInstance`)、`registry.defaultInstance ??=` 首见即锁 + `setDefault()` 覆盖、`requireDefaultInstance()` 错误路径。
- registry 跨副本共享——`registry.ts` 存在的唯一理由(两份模块副本经 `Symbol.for` 槽共享 ALS/默认实例/resolver)——两个包里都没有测试。
- `HttpClient` 侧:200 + 非 JSON body 时 `res.json()` 的 `SyntaxError` 在包装 try 之外逃逸(既不是 HttpError 也不是 KernelError);per-request `timeoutMs` 覆盖 client 级的路径未测。
- `schema.ts` 无直接测试(async Standard Schema validate、`formatIssues` 的 `{ key }` 段、`extractZodMessage` 真实 ZodError 形状、`isSchema` 假阴性)。
- `parseDuration` 无上界:`durationToDate('20000000w')` 产出 Invalid Date,晚至 `toISOString()` 才炸;`"1m1m"` 被静默接受为 120000。

## 实现方案

1. 新建 `packages/sdk/test/instance.test.ts`(mock fetch + fake timers),覆盖上面 instance 清单;p0-03 的重试用例也落在这里,两文件相邻实施可共享脚手架。
2. registry 用例:`vi.resetModules()` 二次 import 模拟双副本,断言 `setResultResolver` 在副本 A 安装、副本 B 可见;`setDefault` 跨副本生效。(与 p1-17 的版本校验用例互补。)
3. `client.test.ts` 补:200 非 JSON body → 包装成可识别错误(实现顺手修:把 `res.json()` 挪进 try 或单独 catch 包 `HttpError(status, 'invalid_json', …)`);per-request timeout 覆盖。
4. `schema.ts`、`duration.ts` 补上述边角(duration 上界:超出 `Date` 安全范围抛 `bad_request` 风格错误;重复单位如 `"1m1m"` 明确拒绝或文档化——选拒绝)。

## 验收标准

- instance/registry/client/schema/duration 各清单条目至少一个用例;`bun run test` 绿。
- `durationToDate('20000000w')` 与 `parseDuration('1m1m')` 有确定行为(错误信息点名输入),不再产出 Invalid Date。
- 200 非 JSON body 的错误可被 `HttpError` 判定捕获。

## 涉及文件

- `packages/sdk/test/instance.test.ts`(新建)、`packages/sdk/test/client.test.ts`
- `packages/sdk/src/client.ts:158`、`packages/sdk/src/schema.ts`
- `packages/core/src/duration.ts`、`packages/core/test/duration.test.ts:88`
