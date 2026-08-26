# P1-05 — SDK `waitForResult` 签名与文档/兄弟方法不一致；README 漏 namespace 与 `retryRun.operationKey`

- 优先级：P1（公共 API 不一致，照文档调用直接编译错误）
- 区域：packages/sdk + docs
- 状态：待办
- 来源：2026-08-26 全仓库审查

## C1 · `waitForResult` namespace 必传与文档/兄弟方法不一致 {#c1}

- 优先级：P1
- 区域：packages/sdk

### 问题摘要

`waitForResult(runId, namespace, opts)` 的 namespace 是必传参数（`Namespace | undefined` 但无 `?`），调用方必须显式传 undefined；而 README 与 docs 都写成 `waitForResult(runId, opts?)`，照文档调用直接编译错误。与兄弟方法（`cancelRun`/`getRun` 的 namespace 都是可选尾参）风格不一致。

### 现状证据

- `packages/sdk/src/instance.ts:141-145` — namespace 无 `?`。
- `README.md:137`、`apps/docs/reference/sdk-api.md:93` — 写成可选。
- `packages/sdk/src/instance.ts` — cancelRun/getRun 的 namespace 为可选尾参。

### 推荐实现方案

- 签名改为 `namespace?: Namespace`（或加 `(runId, opts)` 重载），同步修 README 与 docs 两版。
- 补编译期回归：文档示例代码能通过 typecheck。

## C2 · Instance API 表省略 namespace；`retryRun.operationKey` 未文档化 {#c2}

- 优先级：P1
- 区域：packages/sdk/README.md

### 问题摘要

Instance API 表整体省略 namespace 参数；`retryRun` 的 `opts.operationKey`（p2-38 幂等重试，核心卖点）在 README 完全未提。

### 现状证据

- `packages/sdk/README.md:133-137` — Instance API 表。

### 推荐实现方案

- 表格补 namespace 列；补 `retryRun` 的 `opts`（尤其 `operationKey`）说明。

## 验收标准

- [ ] `waitForResult(runId)` / `waitForResult(runId, opts)` 可编译通过，文档与签名一致。
- [ ] README 覆盖 namespace 与 operationKey。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `packages/sdk/src/instance.ts:141-145`
- `packages/sdk/README.md:133-137`
- `README.md:137`、`apps/docs/reference/sdk-api.md:93`
