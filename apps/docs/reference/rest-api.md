# REST API

All endpoints live under `/api/v1`, speak camelCase JSON, and travel dates as
ISO-8601 strings. Types are the authoritative ones in `apps/worker/src/types.ts`.

## Trigger API

| Method · Path | Body → Response |
|---|---|
| `POST /trigger` | `{ taskId, payload, options? }` → `{ runId, idempotent }` (404 if task unregistered) |
| `POST /batch-trigger` | `{ items: [{ taskId, payload, options? }] }` → `{ runIds }` |

`options`: `{ delay?, idempotencyKey?, priority?, concurrencyKey?, env?, projectId? }`.

## Run API

| Method · Path | Response |
|---|---|
| `GET /runs/:id/record` | `RunRecord` — the run row alone |
| `GET /runs/:id/result?timeoutMs=&pollMs=` | `{ status, output?, error? }` — long-polls to a terminal state (server wait capped at 30s) |
| `POST /runs/:id/cancel` | `{ ok }` |
| `POST /runs/:id/retry` | `{ runId }` (failed/canceled only; creates a fresh run) |

`pollMs` is a deprecated compatibility knob: on a daemon the result wait runs
on one fixed shared sweep that no single request tunes, so the parameter is
accepted (never a 400 from old clients) but inert. It only affects the
embedded `kernel.waitForResult` fallback on hosts without a waiter registry.

`POST /runs/:id/retry` also accepts an optional `Idempotency-Key` request
header (at most 200 characters — longer is a `400 bad_request`, whitespace-only
counts as absent). The key scopes the retry to
`(projectId, env, sourceRunId, Idempotency-Key)`: a repeated send of the same
intent replays the FIRST call's `{ runId }` with a 200 instead of creating a
second run, and the mapping is recorded in the same transaction as the new run,
so a request that never committed created nothing either. Without the header the
call keeps legacy semantics — every delivery is a fresh retry, nothing recorded.

## Dashboard API

| Method · Path | Response |
|---|---|
| `GET /health` | `{ ok, version, sha? }` — liveness, never touches the DB, always open |
| `GET /health?deep=1` | readiness: `{ db, pool: { total, idle, waiting } }`; 503 when the DB is down |
| `GET /tasks` | `{ tasks: TaskSummary[] }` — 24h stats + trend, cached 10s per namespace |
| `GET /runs?env=&taskId=&status=&limit=&cursor=` | `{ runs: RunSummary[], nextCursor }` — keyset on `created_at + id` |
| `GET /runs/:id?logsBefore=` | `{ run, steps, stepsTruncated, waits, waitsTruncated, logs, logsNextCursor }` — one snapshot; newest 200 logs by default |
| `GET /schedules` | `{ schedules: ScheduleSummary[] }` |
| `PATCH /schedules/:id` | `{ enabled }` → `{ ok }` (recomputes `nextRunAt` when enabling) |
| `GET /workers` | `{ workers: WorkerSummary[] }` |
| `GET /metrics` | Prometheus text (`text/plain; version=0.0.4`) — see [Metrics](./metrics) |

Point a **readiness** probe at `?deep=1`, never a **liveness** one. The deep
probe runs on a dedicated probe pool (max 2, `statement_timeout=1000`) so a
hung database can never hold business connections.

`GET /runs/:id` reads run, steps, waits and logs inside one `REPEATABLE READ`
snapshot, so the four parts always agree. Logs come back as the newest 200
lines in chronological order; `logsNextCursor` + `?logsBefore=` pages older
ones. Steps and waits are capped at the newest 500 each (`stepsTruncated` /
`waitsTruncated` when cut).

## Error envelope

Every non-2xx answer uses one envelope:

```json
{ "error": { "code": "task_not_found", "message": "…" } }
```

| code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Invalid input; batch/payload over caps |
| `serialization_error` | 400 | A value JSON cannot represent (circular, BigInt) |
| `unauthorized` | 401 | API key configured but missing/mismatched |
| `key_expired` | 401 | Key's `@<date>` expiry is in the past |
| `not_found` | 404 | Run / schedule / route missing |
| `task_not_found` | 404 | Triggered task id not registered |
| `run_not_running` | 409 | Run no longer running (canceled/requeued/terminal) |
| `stale_lease` | 409 | Fencing token expired (run re-claimed elsewhere) |
| `conflict` | 409 | State forbids the operation (e.g. retrying a non-terminal run) |
| `rate_limited` | 429 | Token bucket exhausted |
| `payload_too_large` | 413 | Request body over `BETTER_TRIGGER_BODY_LIMIT` |
| `internal_error` | 500 | Unexpected; production body is a fixed message + `requestId` |

The SDK restores kernel error codes (`task_not_found`, `run_not_running`,
`stale_lease`, …) to `KernelError` client-side, so `err.code` reads the same
across the wire. Under `NODE_ENV=production`, a 500 body is
`{ error: { code: 'internal_error', message: 'internal error', requestId: 'req_…' } }`
and the real error (with stack) goes only to the server log under that same
id — grep `req_…` to correlate. Kernel-code responses (4xx/409/413) are
byte-identical in both modes.

## Auth & CORS

- With `BETTER_TRIGGER_API_KEY` set, every `/api/v1/*` call except `/health`
  requires `Authorization: Bearer <key>`. The dashboard prompts after a `401`.
- CORS allows only loopback origins (`localhost` / `127.0.0.0/8` / `[::1]`, any
  port) by default; add more with `--cors-origin`.
- Routes that read a body require `Content-Type: application/json` (this is
  what forces a preflight for cross-origin posts).
- `/metrics` follows auth (unlike `/health`): queue size and throughput
  describe your workload.
