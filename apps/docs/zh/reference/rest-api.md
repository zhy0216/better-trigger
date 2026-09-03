# REST API

所有端点都在 `/api/v1` 下，说 camelCase JSON，日期走 ISO-8601 字符串。类型的权威定义在 `apps/worker/src/types.ts`。

## 触发 API

| 方法 · 路径 | 请求体 → 响应 |
|---|---|
| `POST /trigger` | `{ taskId, payload, options? }` → `{ runId, idempotent }`（任务未注册返回 404） |
| `POST /batch-trigger` | `{ items: [{ taskId, payload, options? }] }` → `{ runIds }` |

`options`：`{ delay?, idempotencyKey?, priority?, concurrencyKey?, env?, projectId? }`。

## Run API

| 方法 · 路径 | 响应 |
|---|---|
| `GET /runs/:id/record` | `RunRecord` —— 单独的 run 行 |
| `GET /runs/:id/result?timeoutMs=&pollMs=` | `{ status, output?, error? }` —— long-poll 到终态（服务端单跳上限 30s） |
| `POST /runs/:id/cancel` | `{ ok }` |
| `POST /runs/:id/retry` | `{ runId }`（仅 failed/canceled；创建全新 run） |

`POST /runs/:id/retry` 还支持一个可选的 `Idempotency-Key` 请求头（最长 200 字符，超长返回 `400 bad_request`，纯空白视为未提供）。该键把重试作用域限定在 `(projectId, env, sourceRunId, Idempotency-Key)`：同一意图重复投递会以 200 重放**第一次**调用返回的 `{ runId }`，不再创建第二个 run；映射与新 run 在同一事务内写入，所以从未提交成功的请求同样不会留下任何东西。不带该头时保持旧语义——每次投递都是一次全新重试，不记录。

## Dashboard API

| 方法 · 路径 | 响应 |
|---|---|
| `GET /health` | `{ ok, version, sha? }` —— 存活探针，不碰 DB，始终开放 |
| `GET /health?deep=1` | 就绪探针：`{ db, pool: { total, idle, waiting } }`；库挂返回 503 |
| `GET /tasks` | `{ tasks: TaskSummary[] }` —— 24h 统计 + 趋势，按命名空间缓存 10s |
| `GET /runs?env=&taskId=&status=&limit=&cursor=` | `{ runs: RunSummary[], nextCursor }` —— 基于 `created_at + id` 的 keyset 分页 |
| `GET /runs/:id?logsBefore=` | `{ run, steps, stepsTruncated, waits, waitsTruncated, logs, logsNextCursor }` —— 一个快照；默认最新 200 条日志 |
| `GET /schedules` | `{ schedules: ScheduleSummary[] }` |
| `PATCH /schedules/:id` | `{ enabled }` → `{ ok }`（启用时重算 `nextRunAt`） |
| `GET /workers` | `{ workers: WorkerSummary[] }` |
| `GET /metrics` | Prometheus 文本（`text/plain; version=0.0.4`）——见 [指标](./metrics) |

**就绪**探针请指向 `?deep=1`，**存活**探针永远不要。深探针跑在专用探针连接池（max 2，`statement_timeout=1000`）上，挂死的数据库永远占不住业务连接。

`GET /runs/:id` 在一个 `REPEATABLE READ` 快照里读取 run、steps、waits 与 logs，四部分永远同帧。日志按时间序返回最新 200 条；`logsNextCursor` + `?logsBefore=` 翻更早的页。steps 与 waits 各上限最新 500 条（截断时置 `stepsTruncated` / `waitsTruncated`）。

## 错误信封

所有非 2xx 走同一个信封：

```json
{ "error": { "code": "task_not_found", "message": "…" } }
```

| code | 状态码 | 含义 |
|---|---|---|
| `bad_request` | 400 | 入参不合法；批量 / payload 超限 |
| `serialization_error` | 400 | JSON 无法表示的值（循环、BigInt） |
| `unauthorized` | 401 | 配置了 API key 但缺失/不匹配 |
| `key_expired` | 401 | key 的 `@<date>` 过期后缀已到 |
| `not_found` | 404 | run / schedule / 路由不存在 |
| `task_not_found` | 404 | 触发的 taskId 未注册 |
| `run_not_running` | 409 | run 已不在 running（被取消/重新入队/终态） |
| `stale_lease` | 409 | fencing token 过期（run 已在别处被重新 claim） |
| `conflict` | 409 | 状态不允许该操作（如重试非终态 run） |
| `rate_limited` | 429 | 令牌桶耗尽 |
| `payload_too_large` | 413 | 请求体超过 `BETTER_TRIGGER_BODY_LIMIT` |
| `internal_error` | 500 | 未预期错误；生产环境 body 是固定 message + `requestId` |

SDK 会把内核错误 code（`task_not_found`、`run_not_running`、`stale_lease`……）还原成 `KernelError`，所以 `err.code` 跨网线读起来一样。`NODE_ENV=production` 下 500 body 是 `{ error: { code: 'internal_error', message: 'internal error', requestId: 'req_…' } }`，真实错误（带 stack）只写在服务端日志里、用同一个 id 关联——用 `grep req_…` 对号。内核 code 的响应（4xx/409/413）两种模式下逐字节一致。

## 鉴权与 CORS

- 设置 `BETTER_TRIGGER_API_KEY` 后，除 `/health` 外的所有 `/api/v1/*` 调用需要 `Authorization: Bearer <key>`。dashboard 收到 `401` 后提示输入。
- CORS 默认只放行 loopback 来源（`localhost` / `127.0.0.0/8` / `[::1]`，任意端口）；更多来源用 `--cors-origin`。
- 读 body 的路由要求 `Content-Type: application/json`（这正是跨域 POST 触发预检的机制）。
- `/metrics` 跟随鉴权（与 `/health` 不同）：队列规模与吞吐描述的是你的负载。
