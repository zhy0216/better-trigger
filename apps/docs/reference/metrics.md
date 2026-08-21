# Metrics

`GET /api/v1/metrics` renders Prometheus text (`text/plain; version=0.0.4`).
Everything is prefixed `better_trigger_`. The endpoint follows auth
(`/health` does not): queue size and throughput describe your workload, and a
scraper has somewhere to put a bearer token.

## Metrics

| Metric | Type | What it answers |
|---|---|---|
| `db_up` | gauge | Did this scrape reach Postgres? When `0`, the DB gauges below are **absent** rather than zero |
| `queue_depth{state=available\|scheduled\|claimed}` | gauge | Backlog: due-and-waiting, delayed, currently leased |
| `inflight_runs` | gauge | Runs in `running` across every worker on the database |
| `worker_inflight_runs` | gauge | Runs executing in *this* process |
| `runs_total{outcome=completed\|failed\|suspended\|abandoned}` | counter | Throughput and outcome mix of this process — `outcome`, not `status` (see below) |
| `claim_errors_total`, `claim_errors_consecutive` | counter, gauge | "Daemon looks idle but is failing to claim" |
| `heartbeat_errors_total`, `heartbeat_errors_consecutive` | counter, gauge | Leases drifting towards being reaped |
| `executor_errors_total`, `fail_report_errors_total`, `log_flush_errors_total` | counter | The other best-effort catches |
| `pool_checkout_timeouts_total` | counter | Business-pool checkouts that timed out — the pool is too small |
| `reaper_recovered_total{outcome=requeued\|failed}` | counter | Work the lease reaper had to rescue |
| `orchestrator_errors_total{loop}` | counter | Background loop iterations that threw |
| `loop_last_success_timestamp{loop}` | gauge | Epoch ms of the last successful tick per loop — a stalled timestamp means the loop is stuck |
| `stranded_runs` | gauge | Due runs pinned to a code version no online worker serves — **alert on this one** |
| `stranded_runs_by_version{task_id,code_version}` | gauge | Which build has to come back |
| `notifications_received_total` | counter | `pg_notify` messages received on the `bt` channel |
| `listen_reconnects_total` | counter | Times the LISTEN connection dropped and re-established |
| `waiter_resolutions_total` | counter | `result()` waiters settled by the in-process registry |
| `waiter_timeouts_total` | counter | `result()` waiters that hit their deadline |
| `claim_wakes_total` | counter | Times a work notification woke idle claim loops |

## How to read `runs_total`

The `outcome` label is **not `runs.status`** — it is the executor's verdict on
one execution pass:

- `failed` — this attempt was reported as failed (the kernel may retry it), so
  `sum(runs_total{outcome="failed"})` is attempts-that-failed, not
  runs-that-ended-failed.
- `suspended` — a pass parked on a wait (the run is alive).
- `abandoned` — a claim handed back after the lease was lost.

It is per process and per lifetime: a restart resets it, and a run retried on
another daemon is counted there. For "how many runs are in status X right now",
query the `runs` table or read the dashboard's `/tasks` stats — there is
deliberately no metric for that (it would cost a table scan on every scrape).

## Cost & failure behavior

The two SQL gauges (`db_up`, `queue_depth`, `inflight_runs`) come from one
round trip (2s deadline) on the dedicated probe pool — a failing or hung scrape
borrows a probe connection at most, never a business one, and concurrent
scrapes are single-flight. Everything else is a live in-process counter.

The endpoint answers `200` even when Postgres is down — a successful scrape
reporting `db_up 0` says more than a failed scrape. When the DB is down,
`db_up` is `0` and the queue/inflight gauges are omitted (0 and "don't know"
must not look alike).

`better_trigger_build_info{version,sha}` is a gauge carrying the build identity
from `/health`, so a scrape ties every metric to the exact release and commit.

## Alerting hints

- `claim_errors_consecutive` climbing → the daemon looks idle but cannot claim.
- `pool_checkout_timeouts_total` rising → raise `BETTER_TRIGGER_POOL_MAX`.
- `loop_last_success_timestamp{loop}` stale → the loop is stalled even if its
  error counter is 0.
- `stranded_runs` > 0 (only meaningful with `--pin-code-version`) → a build
  that must come back is missing.
