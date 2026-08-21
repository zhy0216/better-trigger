# 部署与安全

daemon 的设计是**先本地**、需要网络暴露时再加固。本页覆盖安全模型、限制与运维旋钮。完整的环境变量表见 [CLI 与环境变量](/zh/reference/cli-and-env)。

## 网络姿态

API 默认绑定 `127.0.0.1` 且不鉴权——所以“本地”就必须真的是本地。设置 `BETTER_TRIGGER_API_KEY` 后，所有 `/api/v1` 调用（除 `/health`）都要求 `Authorization: Bearer <key>`；SDK 传同一个值。

非 loopback 的 `--host` **且未设 key** 时会拒绝启动，除非显式 `--allow-unauthenticated` 声明这是有意暴露。浏览器来源默认只放行 loopback；其他来源用 `--cors-origin` 添加。

### 多 key 与轮换

`BETTER_TRIGGER_API_KEYS` 在主 key 之外追加更多 key，每个可选带 `key@2030-01-01` 过期后缀（过期后 `401 key_expired`）。轮换就是共存：加新 key → 让旧请求排空 → 移除旧 key。

```bash
BETTER_TRIGGER_API_KEY=sk-old-aaaaaaaa \
BETTER_TRIGGER_API_KEYS=sk-new-bbbbbbbb better-trigger-worker --host 0.0.0.0
```

### 限流

`trigger` / `batch-trigger` / `retry` / `cancel` 按 key 与按端点做令牌桶限流（默认 50/s 与 200/s），超出返回 `429 rate_limited`。读接口也限流但较宽松（默认按 key 200/s、全局 1000/s）。桶在内存里、按进程计；需要精确的全局上限时，在反向代理处限流。

### 审计日志

每个 `/api/v1` 请求向 stdout 写一行结构化 JSON，含 `requestId`、key 指纹、调用方、task/run id、状态与拒绝原因。payload 与 `Authorization` 头永不记录。`requestId` 同时充当生产环境 500 的关联 id 与 `x-request-id` 响应头。

## TLS / 代理 / 数据库

- 在 daemon 前面用反向代理（nginx、Caddy、Traefik、ALB）终结 TLS——daemon 只说明文 HTTP。
- 永远不要用 `X-Forwarded-For` 做执行或审计依据（可伪造）；审计日志只记录 TCP 对端。
- 让 Postgres 只有 daemon 能访问。SDK 从不打开数据库连接，所以“app 不许碰库”是网络规则，不是代码规则。

## 限制

全部可用环境变量覆盖（见参考）：

| 上限 | 默认 |
|---|---|
| 请求体 | 1 MiB → `413 payload_too_large` |
| `batchTrigger` 条数 | 500 → `400 bad_request` |
| 每个 run 的序列化 payload | 256 KiB → `413 payload_too_large` |
| step / run 输出 | 各 256 KiB |
| 错误记录 | 64 KiB |
| 日志行 `data` | 16 KiB |

JSON 无法表示的值（循环结构、BigInt）会以 `400 serialization_error` 拒绝并指名字段——绝不会是会被当成 500 的裸 `TypeError`。大对象请放对象存储，payload 里只传**引用**。

## 可观测性

- `GET /api/v1/health` 始终开放，返回 `{ ok, version, sha? }`；`?deep=1` 加数据库探针与连接池统计（库挂了返回 `503`）。
- `GET /api/v1/metrics` 输出 Prometheus 文本——队列深度、在飞 run、run 结果、claim/heartbeat 错误计数、reaper 恢复、构建信息。
- 完整列表见 [指标](/zh/reference/metrics)。

## 数据保留

保留**默认关闭**——daemon 未经要求不删除任何历史。`--retention 30d` 开启每小时 GC，删除窗口之外的终态 run（step 与日志级联删除）与离线 worker 行。一次性清理：

```bash
better-trigger-worker prune --older-than 30d --dry-run   # 只报告，不删除
better-trigger-worker prune --older-than 30d
```

queued / running / waiting 的 run 无论多老都不会被删，任务与调度也不会。
