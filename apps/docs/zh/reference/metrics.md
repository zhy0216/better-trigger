# 指标

`GET /api/v1/metrics` 输出 Prometheus 文本（`text/plain; version=0.0.4`）。所有指标都有 `better_trigger_` 前缀。该端点跟随鉴权（`/health` 不跟随）：队列规模与吞吐描述的是你的负载，而 scraper 有地方放 bearer token。

## 指标

| 指标 | 类型 | 回答什么问题 |
|---|---|---|
| `db_up` | gauge | 这次 scrape 有没有连上 Postgres？为 `0` 时，下面的两个 DB gauge **缺席**而不是为零 |
| `queue_depth{state=available\|scheduled\|claimed}` | gauge | 积压：到期待领、延时中、正在被租用 |
| `inflight_runs` | gauge | 本数据库所有 worker 上处于 `running` 的 run |
| `worker_inflight_runs` | gauge | *本进程*正在执行的 run |
| `runs_total{outcome=completed\|failed\|suspended\|abandoned}` | counter | 本进程的吞吐与结果结构——`outcome`，不是 `status`（见下） |
| `claim_errors_total`, `claim_errors_consecutive` | counter, gauge | “daemon 看似空闲实则 claim 失败” |
| `heartbeat_errors_total`, `heartbeat_errors_consecutive` | counter, gauge | 租约正滑向被 reaper 回收 |
| `executor_errors_total`, `fail_report_errors_total`, `log_flush_errors_total` | counter | 其余 best-effort 捕获 |
| `pool_checkout_timeouts_total` | counter | 业务连接池 checkout 超时——池太小 |
| `reaper_recovered_total{outcome=requeued\|failed}` | counter | lease reaper 被迫救援的工作量 |
| `orchestrator_errors_total{loop}` | counter | 后台循环迭代抛出的异常 |
| `loop_last_success_timestamp{loop}` | gauge | 每个循环最后一次成功 tick 的 epoch 毫秒——时间戳停住意味着循环卡死 |
| `stranded_runs` | gauge | 到期但没有在线 worker 提供其代码版本的 run——**请给它配告警** |
| `stranded_runs_by_version{task_id,code_version}` | gauge | 哪个构建得回来 |
| `notifications_received_total` | counter | 在 `bt` 频道收到的 `pg_notify` 消息 |
| `listen_reconnects_total` | counter | LISTEN 连接断开并重连的次数 |
| `waiter_resolutions_total` | counter | 进程内 registry 结算的 `result()` 等待者 |
| `waiter_timeouts_total` | counter | 撞上截止时间的 `result()` 等待者 |
| `claim_wakes_total` | counter | work 通知唤醒空闲 claim 循环的次数 |

## 怎么读 `runs_total`

`outcome` 标签**不是 `runs.status`**——它是执行器对单次执行 pass 的判定：

- `failed` —— 这一次尝试被上报为失败（内核很可能还会重试），所以 `sum(runs_total{outcome="failed"})` 是失败过的尝试数，不是以 failed 结束的 run 数。
- `suspended` —— 一次 pass 停在 wait 上（run 还活着）。
- `abandoned` —— 租约丢失后交还的 claim。

它按进程、按生命周期计：重启归零，在另一台 daemon 上重试的 run 记在那台上。要问“现在有多少 run 处于状态 X”，请查 `runs` 表或看 dashboard 的 `/tasks` 统计——这里刻意不提供对应指标（那是对无界历史做聚合，每次 scrape 都要扫表）。

## 成本与故障行为

两个 SQL gauge（`db_up`、`queue_depth`、`inflight_runs`）来自一次往返（2s 截止），跑在专用探针连接池上——失败或挂死的 scrape 最多借用一条探针连接，绝不占用业务连接，且并发 scrape 是 single-flight。其余全是进程内的活计数器。

即使 Postgres 挂了端点也返回 `200`——一次成功报告 `db_up 0` 比一次失败的 scrape 更有信息量。库挂时 `db_up` 为 `0`，queue/inflight 两族 gauge **缺席**（0 与“不知道”不能长得一样）。

`better_trigger_build_info{version,sha}` 携带 `/health` 的构建身份，让每次 scrape 都能把每个指标对应到具体的 release 与 commit。

## 告警提示

- `claim_errors_consecutive` 攀升 → daemon 看似空闲却无法 claim。
- `pool_checkout_timeouts_total` 上升 → 调大 `BETTER_TRIGGER_POOL_MAX`。
- `loop_last_success_timestamp{loop}` 停滞 → 循环已卡死，即使它的错误计数器还是 0。
- `stranded_runs` > 0（只在 `--pin-code-version` 下有意义）→ 有一个必须回来的构建缺席了。
