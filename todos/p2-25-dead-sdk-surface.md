# P2-25 — SDK/core 的死表面:`pollMs` 死参数、core 的幽灵 `RunHandle`、过时注释

- 优先级:P2(DX/API 卫生)
- 区域:sdk / core
- 来源:2026-08-12 第四轮审查(GitMemo「better-trigger 第四轮审查改进点」P2)

## 现状

1. **`pollMs` 是死旋钮**:`core/types.ts:380` 承诺 "Poll interval (default 250ms)",`instance.ts:294` 转发、`routes/runs.ts:55` 钳制——但 `waiters.ts:141-173` 的 `register()` 只读 `timeoutMs`;PF2 把逐 waiter 轮询换成共享 1s sweep + 通知后,daemon 路径再也没人读它(只有嵌入式 host 走 `kernel.waitForResult` 才有效)。用户设 `pollMs: 50` 观察不到任何变化,也无从得知它是惰性的。
2. **core 的幽灵类型**:`core/types.ts:151-153` `export interface RunHandle { id: string }` 全仓零引用,却从 `@better-trigger/core` 公开导出,与 SDK 的真 `RunHandle` 同名——auto-import 抓到它的人拿到一个没有 `result()` 的类型。
3. **过时注释**:`sdk/context.ts:96-97` "`TOutput` is unused here but kept for symmetry" 挂在一个没有类型参数的 interface 上。
4. (`RequestOptions.signal` 的死缝由 p1-17 打通,不在本条。)

## 实现方案

1. `pollMs`:在 `WaitForResultOptions` 上标 `@deprecated`,JSDoc 写明 "daemon 路径为通知驱动,本参数仅对嵌入式 kernel fallback 生效";或者(更彻底)在 waiter registry 里把它落成 per-waiter 的 sweep 下限——二选一,推荐先 deprecate,是否落地 per-waiter 粒度看真实需求。
2. 删除 core 的 `RunHandle`(内部无引用,属于公开 API 破坏——在 CHANGELOG 记一行;`check:exports` 会确认无悬挂)。
3. 修正 `context.ts:96-97` 注释。
4. sdk README / core 的类型导出清单同步。

## 验收标准

- `bun run check:exports`、`typecheck`、全测试绿。
- grep 确认 core 不再导出 `RunHandle`;`pollMs` 带 deprecated 标注且 IDE 可见。

## 涉及文件

- `packages/core/src/types.ts:151-153`、`:380`
- `packages/sdk/src/context.ts:96-97`、`packages/sdk/src/instance.ts:294`
- `packages/sdk/README.md`
