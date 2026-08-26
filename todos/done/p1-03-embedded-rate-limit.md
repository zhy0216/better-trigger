# P1-03 — embedded 模式进程内 fetch 被自己的 rate limiter 限流

- 优先级：P1（功能正确性 + 性能）
- 区域：apps/worker（embedded runtime）
- 状态：待办
- 来源：2026-08-26 全仓库审查

## 问题摘要

`createEmbeddedRuntime` 用进程内 fetch 连接 SDK client，但该请求同样经过 `rateLimitMiddleware`。无 API key 时 `remoteAddressOf` 返回 null → `keyId='anon'`，进程内全部 SDK 调用共享一个 anon 桶（trigger 默认 50 rps / burst 200）。高吞吐 embedded 应用会对自己的业务调用返回 429。

## 现状证据

- `apps/worker/src/embedded.ts:361-376` — 进程内 fetch adapter。
- `apps/worker/src/app.ts:115` — rateLimitMiddleware 挂载。
- `apps/worker/src/rate-limit.ts` — anon 桶逻辑（keyId 为 null 时）。

## 影响与不变量

- 进程内、同宿主、可信任的 embedded 调用不应受面向外部客户端的限流约束；限流是保护外部暴露面的机制。
- 若选择保留限流（简单一致），必须文档化默认配额，且不得让默认值在常见吞吐下误伤。
- 不改变 daemon 模式的外部限流语义。

## 推荐实现方案

- 方案 A（推荐）：进程内 fetch 绕过 rateLimitMiddleware，或打上可信来源标记后跳过限流；仍保留 audit 日志。
- 方案 B：保留限流但给 anon 桶可配/默认更大的额度，并在 README/embedded 文档显式说明。
- 补测试：embedded 模式高并发触发不产生 429。

## 验收标准

- [ ] embedded 应用连续触发超过 50 rps 不被自己限流。
- [ ] daemon 模式外部请求限流行为不变。
- [ ] 文档说明最终取舍。
- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。

## 涉及文件

- `apps/worker/src/embedded.ts:361-376`
- `apps/worker/src/app.ts:115`
- `apps/worker/src/rate-limit.ts`
- `apps/worker/test/`、`packages/testing/`
