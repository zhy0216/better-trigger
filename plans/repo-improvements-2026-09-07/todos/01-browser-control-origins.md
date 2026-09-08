difficulty: medium
agent: inherit

# 浏览器控制请求来源校验

对应 plan F1。优先级 P1。前置依赖：无。文件范围为 worker HTTP 边界及对应测试，不改状态机、鉴权凭据存储或 SDK API。

## T1 · 在副作用前拒绝不允许的浏览器来源

- 要做什么：检查 `createApp` 的中间件顺序、`allowedOrigin` 与 cancel/retry；建立统一的不安全方法来源检查，明确覆盖无 body POST。若采用 Hono CSRF，先验证其实际 Content-Type 覆盖范围，不能只套中间件名字或只省略 ACAO。
- 预计修改：`apps/worker/src/app.ts`、`apps/worker/src/middleware.ts`，必要时 `apps/worker/src/routes/runs.ts`；对应 `test/middleware.test.ts`、`test/http.test.ts`、`test/auth.test.ts`。
- 验收：Origin=https://untrusted.example 的无 body cancel/retry 在调用 kernel 前以稳定 4xx 拒绝；Origin=null、表单/simple Content-Type 等同类入口覆盖。允许的同源、loopback、显式配置 origin、显式 wildcard 维持预期；无 Origin 的 SDK/curl/embedded 请求继续可用。检查来源不能消耗 run 操作或绕过已有 auth/rate-limit，审计记录拒绝结果。
- 前置依赖：无。

## T2 · 锁定同源与代理使用场景

- 要做什么：补正反两面的请求回归和边界注释，明确 CORS 响应读取限制与服务器是否执行是两回事。同源远程 HTTPS Dashboard 不能因不是 localhost 而被拦。
- 预计修改：上述测试及 `middleware.ts` 注释；若需外部说明，仅在当前任务拥有的说明位置补充，不并行改其他任务文档。
- 验收：测试断言被拒绝请求的 kernel 调用数为 0，并断言合法请求实际调用一次；OPTIONS、健康检查、API key 错误、JSON body 校验等旧路径通过。使用合成 origin/run id，测试不连接真实部署。
- 前置依赖：本文件 T1。

验证：`bun run --cwd apps/worker test -- test/middleware.test.ts test/http.test.ts test/auth.test.ts test/body-limit.test.ts test/embedded.test.ts`，随后运行 todos/README.md 的完整仓库 gate。只留下一个最终任务 commit，验收齐备才归档本文件。
