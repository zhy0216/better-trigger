difficulty: easy

# 05 · wait result 的 pollMs 兼容契约

覆盖方案 F6。`pollMs` 继续作为兼容字段被 SDK/REST 接受；daemon 的 waiter registry 使用自身固定共享 sweep，只有没有 registry 的 embedded kernel fallback 才使用该值。

## T1 · 停止向 daemon waiter 伪传递 pollMs

- 要做什么：调整 `/runs/:id/result` 路由，把 `timeoutMs` 与兼容的 `pollMs` 分开处理：`deps.waiters` 存在时只把真正生效的等待预算传给 registry，query 中的 `pollMs` 不得改变或伪装成改变共享 sweep；没有 registry 时继续 clamp 并传给 `kernel.waitForResult`。REST 对旧 query 不报错，embedded kernel 的 `pollMs >= 1` 校验和轮询行为不变。
- 预计修改文件：`apps/worker/src/routes/runs.ts`、`apps/worker/test/http.test.ts`、`apps/worker/test/waiters.test.ts`；如类型签名需要收紧，同步 `apps/worker/src/waiters.ts`。
- 验收条件：同一 daemon registry 上分别请求 `pollMs=50` 与 `pollMs=5000`，共享 sweep 周期/查询次数不变；waiter 注册参数不再携带无效 pollMs；无 registry 的 fallback 仍收到 clamp 后的 50–5000ms 值；旧 query 继续返回正常响应而非 400；现有 abort 499、terminal notify 与 timeout 测试通过。
- 前置依赖：`03-rate-limit-zero-contract.md`（共享 `apps/worker/README.md`，实现逻辑本身无依赖）。

## T2 · 校准 SDK 注释和中英文 API 文档

- 要做什么：明确 SDK 的 `WaitForResultOptions.pollMs` 在 daemon 路径 deprecated/inert，SDK 为兼容可继续发送该 query；说明它只对 embedded/no-registry kernel fallback 生效。修正把该参数描述为“共享扫描间隔”的文档，避免调用者误以为单请求能调节 daemon sweep。
- 预计修改文件：`packages/core/src/types.ts`、`packages/sdk/src/instance.ts`、`packages/sdk/test/instance.test.ts`（只更新兼容契约相关断言/命名）、`docs/backend-contract.md`、`apps/worker/README.md`、`apps/docs/reference/rest-api.md`、`apps/docs/zh/reference/rest-api.md`。
- 验收条件：类型注释、SDK 行为、worker README、backend contract 与 VitePress 中英文 reference 对 daemon/embedded 的描述一致；SDK query 兼容测试保留，且不声称它控制 daemon sweep；`bun run --cwd apps/docs build` 通过。
- 前置依赖：T1。

## 本文件验证

`bun run --cwd apps/worker test -- http.test.ts waiters.test.ts && bun run --cwd packages/sdk test -- instance.test.ts && bun run --cwd apps/docs build && bun run typecheck && bun run lint && bun run build && bun run test`。
