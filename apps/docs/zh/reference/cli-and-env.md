# CLI 与环境变量

daemon 二进制是 `better-trigger-worker`。每个 flag 都有对应的环境变量，反之亦然。权威列表请运行 `better-trigger-worker --help`——帮助文本由同一份 registry（`apps/worker/src/env-registry.ts`）生成，CI 里有一个测试保证它与源码不漂移。

## CLI flags

```
--tasks <path>           导出 task() handle 的模块（可重复 / 逗号分隔）
--port <n>               HTTP 端口                    (env PORT, 默认 4848)
--host <addr>            绑定地址                     (env BETTER_TRIGGER_HOST, 默认 127.0.0.1)
--allow-unauthenticated  允许非 loopback --host 且不设 API key
--cors-origin <origin>   额外放行的浏览器来源（可重复 / `*`）
--concurrency <n>        并发执行槽                   (env BETTER_TRIGGER_CONCURRENCY, 默认 5)
--name <s>               dashboard 里显示的 worker 名
--lease-ms <n>           claim 租约时长               (默认 60000)
--timer-interval-ms <n>  wait 到期扫描间隔            (默认 1000)
--cron-interval-ms <n>   cron 扫描间隔                (默认 1000)
--reaper-interval-ms <n> 过期租约回收间隔             (默认 10000)
--retention <duration>   开启保留 GC 循环（"30d"、"72h"）
--gc-interval-ms <n>     保留 GC 间隔                 (默认 3600000)
--pin-code-version       只 claim 本进程能重放的代码版本的 run
--stranded-interval-ms <n> 滞留 run 扫描间隔          (默认 30000)
--database-url <s>       Postgres 连接串              (env DATABASE_URL)
--no-migrate             启动时不应用迁移
--no-serve               只执行、不服务 HTTP
-h, --help               显示帮助
```

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/better_trigger` | Postgres 连接串 |
| `PORT` | `4848` | HTTP 监听端口 |
| `BETTER_TRIGGER_HOST` | `127.0.0.1` | 绑定地址（默认 loopback） |
| `BETTER_TRIGGER_ALLOW_UNAUTHENTICATED` | _(未设)_ | `1`/`true` = `--allow-unauthenticated` |
| `BETTER_TRIGGER_CORS_ORIGIN` | _(未设)_ | 额外浏览器来源，逗号分隔 |
| `BETTER_TRIGGER_NAMESPACES` | `default/prod` | 本 worker 服务的命名空间，逗号分隔 `<projectId>/<env>` |
| `BETTER_TRIGGER_CONCURRENCY` | `5` | 并发执行槽 |
| `BETTER_TRIGGER_BODY_LIMIT` | `1048576` | 请求体字节上限 → `413` |
| `BETTER_TRIGGER_MAX_BATCH` | `500` | 单次 `batchTrigger` 条数上限 → `400` |
| `BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES` | `1048576` | 一次 `batchTrigger` 的总 payload 上限 → `400` |
| `BETTER_TRIGGER_MAX_PAYLOAD_BYTES` | `262144` | 每 run 序列化 payload 上限 → `413` |
| `BETTER_TRIGGER_MAX_STEPS` | `10000` | 重放 step 账本上限；超限 run 被截断并**不可重试**（`0` = 无限） |
| `BETTER_TRIGGER_MAX_RECOVERIES` | `10` | 盖章到新 run 的 reaper 恢复预算（`0` = 永不恢复） |
| `BETTER_TRIGGER_POOL_MAX` | _派生_ | 业务连接池上限（`--concurrency + 8`） |
| `BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS` | `10000` | 连接池 checkout / 连接超时 |
| `BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS` | `30000` | 服务端 `statement_timeout` |
| `BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION` | _(未设)_ | `1` = 让游离的 `unhandledRejection` 致命 |
| `BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES` | `262144` | 每行 step 输出/错误上限 |
| `BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES` | `262144` | 序列化 run 输出上限 |
| `BETTER_TRIGGER_ERROR_MAX_BYTES` | `65536` | 序列化错误记录上限 |
| `BETTER_TRIGGER_LOG_DATA_MAX_BYTES` | `16384` | 单条日志 `data` 序列化上限 |
| `BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES` | `65536` | 单条日志 message 序列化上限 |
| `BETTER_TRIGGER_LOG_BATCH_MAX_BYTES` | `262144` | 单次日志 INSERT 的序列化 payload 上限 |
| `BETTER_TRIGGER_STATS_TTL_MS` | `10000` | `/tasks` 统计缓存 TTL |
| `BETTER_TRIGGER_API_KEY` | _(未设)_ | 设置后，除 `/health` 外的所有 `/api/v1/*` 需要 `Authorization: Bearer <key>` |
| `BETTER_TRIGGER_API_KEYS` | _(未设)_ | 追加的 bearer key，逗号分隔，可选 `@<date>` 过期后缀 |
| `BETTER_TRIGGER_RATE_LIMIT_RPS` | `50` | 每 key 每端点的写限流（令牌/秒） |
| `BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS` | `200` | 每端点全局写限流 |
| `BETTER_TRIGGER_RATE_LIMIT_READ_RPS` | `200` | 每 key 读限流 |
| `BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS` | `1000` | 全局读限流 |
| `BETTER_TRIGGER_RATE_LIMIT_BURST` | _较大写速率_ | 令牌桶容量；`0` 禁用整个限流器 |
| `BETTER_TRIGGER_PIN_CODE_VERSION` | _(未设)_ | `1`/`true` = `--pin-code-version` |
| `BETTER_TRIGGER_VERSION` | _(构建身份)_ | 注册时上报的代码版本（覆盖所有 per-task 版本） |

将 RPS 限流旋钮设为 `0` 只关闭对应维度的桶；将 `BETTER_TRIGGER_RATE_LIMIT_BURST` 设为 `0` 会禁用整个限流器（不创建也不消费任何桶）。缺失、为负或无法解析的值回落到默认值，而不会把上限关掉。
