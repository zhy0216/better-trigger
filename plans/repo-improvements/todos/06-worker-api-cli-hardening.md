difficulty: medium

# 06 · worker API / CLI 硬化

覆盖 `apps/worker` 的 HTTP 路由、中间件、CLI 与 waiter 注册表。与 07 文件不相交（07 负责 executor/runtime/observability/static），可并行。

## T1 · CORS allowHeaders 补 Idempotency-Key（P2）

- 做什么：`apps/worker/src/middleware.ts:116` 只允许 `['Authorization', 'Content-Type']`，但 `POST /runs/:id/retry` 读取非 CORS 安全名单的 `Idempotency-Key`（`routes/runs.ts:42`）——任何使用 `--cors-origin` 的浏览器调用方带该头时预检失败、请求被拦。加 `'Idempotency-Key'`；扩 `test/middleware.test.ts`（现只请求 `content-type` 只断言 Authorization，`:49,120`）：预检请求 `idempotency-key` 并断言出现在 `Access-Control-Allow-Headers`。
- 预计文件：`apps/worker/src/middleware.ts`、`apps/worker/test/middleware.test.ts`。
- 验收：新预检测试通过；既有 CORS 测试全绿。
- 前置依赖：无。

## T2 · GET /runs 游标保精度（P2）

- 做什么：`routes/dashboard.ts:327-339,384` 游标为 `${created_at.toISOString()}|${id}`；JS ISO 截断到毫秒，pg `timestamptz` 是微秒。同毫秒内更晚的亚毫秒行在 `ORDER BY created_at DESC` 下排在该页末行之前，却过不了下一页 `created_at < $cAt`（截断游标严格更小）→ 静默丢行。批量/批触发在同一事务内共享同一 `now()`，实际可达。修法：游标保留全精度——服务端用 `to_char(created_at, ...US...)` 输出微秒（或 `extract(epoch ...)`）构造游标，解析端对称；保持 `(created_at, id)` keyset 结构。
- 预计文件：`apps/worker/src/routes/dashboard.ts`、`apps/worker/test/`（新增：同毫秒多行分页不丢行；现游标测试用空结果 stub，测不到）。
- 验收：真 PG（或足量 stub）下同毫秒 ≥3 行分页遍历无丢失无重复；既有 dashboard 路由测试全绿。
- 前置依赖：无。

## T3 · GET /workers 排序加 tiebreaker（P2）

- 做什么：`routes/dashboard.ts:552` `ORDER BY started_at DESC` 无决胜列；同毫秒启动的 worker 行（`bun --watch` 重启、多 daemon 并起）分页不一致。加 `, id DESC`（对齐 GET /runs 的正确写法）。
- 预计文件：`apps/worker/src/routes/dashboard.ts`、测试。
- 验收：同 `started_at` 行的分页顺序稳定；新增断言。
- 前置依赖：无。

## T4 · CLI 上限与取值报错（P2）

- 做什么：`cli.ts:230-236` `requireInt` 只要求正整数：`--port 70000` 通过解析、在 `listen()` 里炸出天书错；`--concurrency 1e9` 通过解析、注册后在 `runtime.ts:425` `Array.from({ length: concurrency })` 炸 RangeError/OOM。给 `--port` 上限 65535、`--concurrency` 上限（如 1000，取合理值并注释），沿用 `requireLeaseMs` 的"启动即失败"哲学。顺带：`value()`（`cli.ts:399-407`）对以 `-` 开头的值报误导性的 "requires a value"，改进措辞。
- 预计文件：`apps/worker/src/cli.ts`、`apps/worker/test/config-validation.test.ts`（或新文件）。
- 验收：越界值启动即报清晰错误；合法值不变；新增测试钉住上下界。
- 前置依赖：无。

## T5 · `--help` 先于 env 校验（P2）

- 做什么：`cli.ts:366-391` 在 argv 循环看到 `-h/--help`（`:410-414`）之前就构造 `opts`、急切执行 `parsePositiveIntEnv`/`parseMaxSteps`——`PORT` env 拼错连 `better-trigger-worker --help` 都报错退出；`prune --help` 对坏 `BETTER_TRIGGER_NAMESPACES` 同理。修法：先扫 `-h/--help` 短路，或把 env 解析推迟到 flag 处理之后。
- 预计文件：`apps/worker/src/cli.ts`、测试。
- 验收：坏 env + `--help` 正常打印用法并以 0 退出；无 `--help` 时坏 env 仍启动即失败。
- 前置依赖：无。

## T6 · waiter abort 监听器随 settle 移除（P2）

- 做什么：`waiters.ts:215-233` `register()` 以 `{ once: true }` 把 `onAbort` 挂到请求 signal，但 `settle`/`settleTimeout`/`settleGone`/`stop()` 只删 map 条目、不 `removeEventListener`——监听器与其闭包的 `PendingWaiter` 活到 signal 触发或请求对象被 GC。把 `onAbort`/`signal` 存在条目上，`remove()` 时摘除监听。
- 预计文件：`apps/worker/src/waiters.ts`、`apps/worker/test/`（waiter 套件）。
- 验收：正常 settle 后 signal 上无残留监听（测试可用 `listenerCount`/spy 断言）；abort 路径行为不变。
- 前置依赖：无。

## T7 · `--database-url` 凭据暴露警示（P2）

- 做什么：`cli.ts:465-466`（prune 同见 `:546`）接受 `--database-url postgres://user:pass@…`，凭据在进程生命周期内对同机任意用户经 `ps`/`/proc/<pid>/cmdline` 可见；env 形式不可见。保留该 flag（是文档化的 env 孪生），但当值含 `://…:…@` 时启动打印一次警告建议改用 `DATABASE_URL`，并在 `--help` 文案注明。
- 预计文件：`apps/worker/src/cli.ts`、测试。
- 验收：带凭据的 `--database-url` 触发一次警告；不带凭据不警告；行为不变。
- 前置依赖：无。

## 本文件验证

`bun run typecheck && bun run lint && bun run build && bun run test`；T2 若走真 PG 路径需设置 `DATABASE_URL`。
