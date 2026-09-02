# P1-15 — SDK：响应 body 读取脱离超时/AbortSignal 保护区

- 优先级：P1（合约破坏 / 可挂起）
- 区域：packages/sdk
- 状态：待办
- 来源：2026-09-02 全仓库审查（第二轮）

## C1 · body 读取在 timeout/abort 清理之后 {#c1}

### 问题摘要

请求函数在 `fetch` 拿到响应头后的 `finally` 里立即 `clearTimeout` 并移除调用方
`abort` 监听器，随后的 `await res.json()` 与 `toError(res)`（也要读 body）都在
保护区外执行。后果：

- 慢速/滴漏式响应体可以无限挂起，突破 `timeoutMs` 合约；
- 调用方在 body 阶段 abort（例如 run 的 `ctx.signal`）被忽略；
- 对 `getRunDetail`（500 步 + 200 行日志的大响应）与 `result()` 长轮询是真实的
  超时语义漏洞。

### 现状证据

- `packages/sdk/src/client.ts:178-197`：`finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }`
  之后才有 `if (!res.ok) throw await toError(res)` 与 `await res.json()`。

### 推荐实现方案

- 把 timer/监听器的清理推迟到 body 消费完成（成功与失败两条路径都覆盖）；
  超时或外部 abort 触发 `controller.abort()` 时 body 读取随之中断并落到既有
  `timeout` / abort 错误路径。注意 `toError` 也读 body，两条路径都要在保护区内。

## C2 · per-request `timeoutMs` 覆盖绕过正值校验 {#c2}

### 问题摘要

构造函数对 `timeoutMs` 有正值校验，但 per-request 覆盖直接取值使用——非法值
（如 0、负数、NaN）会退化为「立即超时」而不是报错，排障时极具误导性。

### 现状证据

- `packages/sdk/src/client.ts:117` 附近：per-request `timeoutMs` 覆盖未经校验。

### 推荐实现方案

- 复用构造函数的校验逻辑：非法覆盖值抛同样的配置错误（或回退构造值，二选一并
  写明理由；倾向抛错，与构造路径一致）。

## 验收标准

- [ ] `bun run typecheck`、`bun run build`、`bun run test` 全部通过。
- [ ] 新增单测：响应头立即返回但 body 延迟超过 `timeoutMs` → 按超时失败；
  body 阶段外部 abort → 按 abort 失败；非法 per-request `timeoutMs` → 报错。

## 涉及文件

- `packages/sdk/src/client.ts`
