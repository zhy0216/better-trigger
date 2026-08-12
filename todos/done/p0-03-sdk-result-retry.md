# P0-03 — `handle.result()` 续期循环无重试,daemon 滚动重启拒绝所有等待者

- 优先级:P0(SDK 合同,每次部署必现)
- 区域:sdk
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」#3)

## 现状

`packages/sdk/src/instance.ts:286-308` 的 `waitForResult` 续期循环里 `await http.request(...)` 没有任何 try/catch——一次 5xx 或网络错误直接把整个 `result()` reject。

而服务端是按"SDK 会重试"设计的:`apps/worker/src/waiters.ts:58-64` 的 `WaiterRegistryStoppedError` 注释写明——关停时把所有 pending waiter 拒绝掉,"Deliberately NOT a terminal status… The route maps it to a 5xx **the SDK can retry against another daemon**"。合同的另一半从未实现;该错误现在经 `app.onError` 变成 `500 internal_error` → SDK 侧 `HttpError(500)` 直接抛给调用方。

## 影响

- 每次部署 / 单个 daemon 重启:`waiters.ts:264` reject 所有 pending waiter,所有 in-flight `result()` 同时报错——即使 run 健康、马上会由另一个 daemon 完成、调用方自己的 timeout 预算还剩几分钟。
- 一次代理 502 / 连接抖动同样中断整个等待。
- 在请求路径里 `await handle.result()` 的应用,每次 deploy 都对用户 500。README 承诺的优雅重启故事对 SDK 调用方不成立。

## 实现方案

1. 在 `waitForResult` 的 for 循环里包 try/catch:
   - `HttpError` 且 `status === 0`(网络/超时)或 `status >= 500`:若 `Date.now() < deadline`,按带抖动的指数退避(如 200ms 起、×2、上限 2s、±20% jitter)sleep 后 `continue`;deadline 已到则抛出**最后一次的错误**(不能伪造终态)。
   - `KernelError`(如 `not_found`)与 4xx:立即抛出,不重试。
2. 退避 sleep 需感知剩余预算:`sleep = min(backoff, deadline - now)`,避免超预算。
3. 服务端配合(可选但建议):`apps/worker/src/app.ts` 的 onError 把 `WaiterRegistryStoppedError` 映射为 `503` + 明确 code(如 `waiter_abandoned`),而不是笼统 `500 internal_error`——SDK 的重试判据不变(≥500 都重试),但审计日志与人排查时语义清晰。
4. `packages/sdk/README.md` 的 `result()` 小节补一句:瞬态 5xx/网络错误在预算内自动重试;超预算抛最后一次错误。

## 验收标准

- 新增 `packages/sdk/test/instance.test.ts`(mock fetch):
  - 第一跳 503、第二跳返回终态 → `result()` 成功,且中间有退避;
  - 连续 5xx 直到 deadline → 抛出 HttpError(而非静默返回);
  - `not_found` 立即抛出,无重试;
  - 退避不会把总时长推过 `timeoutMs`。
- 扩展 `examples/basic/scripts/rolling-deploy.ts`(或 graceful-restart):在重启窗口内挂起若干 `handle.result()`,断言全部拿到终态而非报错。
- `bun run test` / `bun run test:acceptance` 全绿。

## 涉及文件

- `packages/sdk/src/instance.ts:286-308`
- `apps/worker/src/waiters.ts:58-69`、`apps/worker/src/app.ts`(onError 映射)
- `packages/sdk/test/`(新建 instance.test.ts)
- `examples/basic/scripts/rolling-deploy.ts`
- `packages/sdk/README.md`
