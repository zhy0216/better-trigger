difficulty: easy

# 03 · Rate-limit 零值契约

覆盖方案 F4，采用现有公开文档承诺的“0 disables”语义：`BETTER_TRIGGER_RATE_LIMIT_BURST=0` 禁用 token bucket，而不是让所有请求永久 429。

## T1 · 让 BURST=0 绕过读写桶

- 要做什么：在 `rateLimitConfigFromEnv`/`rateLimitMiddleware` 的清晰边界实现 `burst === 0` 禁用整套 token-bucket 检查；该路径不得创建或消费 per-key/global 的读写桶。其他 RPS knob 为 0 时只禁用对应维度，负数/非整数/不可解析值仍回落默认值。保持动态 env 每请求读取：运行中在 0 与正值之间切换后立即采用新语义。
- 预计修改文件：`apps/worker/src/rate-limit.ts`、`apps/worker/test/rate-limit.test.ts`；仅在现有覆盖需要同步时调整 `apps/worker/test/env-registry.test.ts` 或 `apps/worker/test/config-validation.test.ts`。
- 验收条件：`BURST=0` 时 trigger/batch/cancel/retry/schedule 及 read API 连续请求均不返回 429，per-key/global 组合均覆盖；`BURST=1` 时第二个同桶请求仍返回 429；0→1 与 1→0 的动态更新有回归测试；现有 key/IP 隔离、embedded bypass、refill 和默认值测试保持通过。
- 前置依赖：无。

## T2 · 同步 env help 与中英文文档

- 要做什么：消除“0 disables”与“零值回落默认”并存的描述。明确 BURST=0 禁用整个 limiter、各 RPS=0 只禁用对应维度、负数或非法输入回落默认，并保持根 README、worker README、env registry 以及 VitePress 中英文镜像一致。
- 预计修改文件：`apps/worker/src/env-registry.ts`、`README.md`、`apps/worker/README.md`、`apps/docs/reference/cli-and-env.md`、`apps/docs/zh/reference/cli-and-env.md`。
- 验收条件：上述五处对 0/缺失/负数/非法值的表述一致；`rg` 不再找到“zero falls back”与“0 disables”的互相矛盾文本；`bun run --cwd apps/docs build` 通过。
- 前置依赖：T1。

## 本文件验证

`bun run --cwd apps/worker test -- rate-limit.test.ts && bun run --cwd apps/docs build && bun run typecheck && bun run lint && bun run build && bun run test`。
