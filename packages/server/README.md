# @better-trigger/server

The better-trigger control plane: a Hono HTTP API + Postgres-backed durable
queue, replay engine, retry/backoff, cron scheduler and parent/child
orchestration. Workers long-poll it for work; the dashboard reads from it.

Stack: Hono + `@hono/node-server`, `drizzle-orm` (node-postgres / pg Pool),
`croner`, `@better-trigger/core`. ESM, built with tsup (esm + cjs + dts).

## Quick start

```bash
# 1. Postgres (Docker). From the repo root:
docker compose up -d                 # starts only postgres:16 on :5432

# 2. Run the server (from packages/server)
bun run dev                          # bun --watch src/main.ts
# or, after a build:
bun run build && bun run start       # node dist/main.js
```

On boot the server runs an **idempotent migration** (hand-written
`CREATE TABLE IF NOT EXISTS …`, no drizzle-kit), starts the orchestrator loops,
then listens on `PORT` (default `4848`). `SIGINT` / `SIGTERM` shut it down
gracefully (stop loops → close server → drain the pool).

### Run everything in Docker

```bash
docker compose --profile server up   # postgres + the server image
```

The `server` service is gated behind a compose **profile** so the default
`docker compose up` only brings up Postgres (the common dev setup is Postgres in
Docker, server + worker on the host).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/better_trigger` | Postgres connection string |
| `PORT` | `4848` | HTTP listen port |
| `BETTER_TRIGGER_API_KEY` | _(unset)_ | When set, every `/api/v1/*` call (except `/health`) requires `Authorization: Bearer <key>`. Unset = local mode, no auth. |

CORS is open (`*`) for local tooling.

## Orchestrator loops

Four `setInterval` loops run in-process (each re-entrancy guarded, all using
`FOR UPDATE SKIP LOCKED` where they mutate shared rows):

| Loop | Interval | Job |
|---|---|---|
| wait scanner | 1s | resume `duration`/`until` waits whose `resume_at <= now()` |
| cron scheduler | 1s | fire due schedules, recompute `next_run_at` (croner, timezone-aware) |
| visibility reaper | 10s | recover runs locked > **60s** (re-queue, or fail as `worker lost` past max attempts) |
| worker reaper | 30s | mark workers `offline` after **2m** with no heartbeat |

## API

All endpoints live under `/api/v1`, speak camelCase JSON, and travel dates as
ISO-8601 strings. Request/response types are the authoritative ones in
`@better-trigger/core` (`protocol.ts`).

### Worker protocol

| Method · Path | Body → Response |
|---|---|
| `POST /workers/register` | `{ name?, codeVersion, runtime, concurrency, tasks: TaskManifest[] }` → `{ workerId, heartbeatIntervalMs, visibilityTimeoutMs }` (upserts tasks + schedules) |
| `POST /workers/:id/heartbeat` | `{ runIds }` → `{ ok, cancelRunIds }` (extends locks; reports canceled runs) |
| `GET /dequeue?workerId=&timeoutMs=` | → `{ run }` or `{ run: null }` (long-poll, ≤30s, 500ms interval) |
| `POST /runs/:id/steps` | report a memoized step (`{ seq, kind, status, output?, error?, … }`) → `{ ok }` |
| `POST /runs/:id/suspend` | `{ seq, kind, resumeAt, … }` → `{ ok, resumed }` (`resumed:true` = already due) |
| `POST /runs/:id/wait-for-run` | `{ seq, taskId, payload, options?, … }` → `{ childRunId }` (triggerAndWait) |
| `POST /runs/:id/batch-trigger` | `{ seq, items, … }` → `{ runIds }` (durable, idempotent on `(runId, seq)`) |
| `POST /runs/:id/complete` | `{ output }` → `{ ok }` (terminal; wakes a waiting parent) |
| `POST /runs/:id/fail` | `{ error, stepSeq?, retry?, abort? }` → `{ ok, willRetry, nextAttemptAt? }` |
| `POST /runs/:id/logs` | `{ logs }` → `{ ok }` (best effort, any run status) |

Reporting endpoints (everything except `logs`) require the run to be `running`
and locked by the calling worker, else `409 { error: { code: 'run_not_running' } }`.

### Trigger API (app code / dashboard)

| Method · Path | Body → Response |
|---|---|
| `POST /trigger` | `{ taskId, payload, options? }` → `{ runId, idempotent }` (404 if task unregistered) |
| `POST /batch-trigger` | `{ items }` → `{ runIds }` |

`options`: `{ delay?, idempotencyKey?, priority?, concurrencyKey?, env? }`.

### Dashboard API

| Method · Path | Response |
|---|---|
| `GET /health` | `{ ok, version }` (always open, no auth) |
| `GET /tasks` | `{ tasks: TaskSummary[] }` (runs24h, p50/p95, successRate, 12×2h trend) |
| `GET /runs?env=&taskId=&status=&limit=&cursor=` | `{ runs: RunSummary[], nextCursor }` (keyset on `created_at + id`) |
| `GET /runs/:id` | `{ run, steps, waits, logs }` (logs capped at 1000) |
| `POST /runs/:id/cancel` | `{ ok }` |
| `POST /runs/:id/retry` | `{ runId }` (failed/canceled only; creates a fresh run) |
| `GET /schedules` | `{ schedules: ScheduleSummary[] }` |
| `PATCH /schedules/:id` | `{ enabled }` → `{ ok }` (re-computes `nextRunAt` when enabling) |
| `GET /workers` | `{ workers: WorkerSummary[] }` |

Errors use a uniform envelope: `{ error: { code, message } }` — `404 not_found`
for missing resources, `400` for validation failures, `409 run_not_running`
for stale worker reports.

## Layout

```
src/
├── main.ts               # process entry: migrate → orchestrator → serve
├── index.ts              # library surface (createApp, db, orchestrator, …)
├── app.ts                # Hono assembly + uniform error handler
├── middleware.ts         # bearer auth + CORS
├── ids.ts                # run_/sch_/wkr_ id generation
├── db/
│   ├── schema.ts         # Drizzle tables (contract §2 + concurrency_key on runs)
│   ├── migrate.ts        # idempotent DDL, run on boot
│   └── index.ts          # pg Pool + drizzle instance
├── engine/
│   ├── queue.ts          # enqueue / SKIP-LOCKED dequeue / lock renew/release
│   ├── runs.ts           # create/steps/suspend/wait-for-run/batch/complete/fail/cancel/retry
│   ├── orchestrator.ts   # 4 timer loops + cron next-run computation
│   └── stats.ts          # task aggregations (percentile_cont, trend buckets)
└── routes/
    ├── workers.ts        # register / heartbeat / dequeue
    ├── trigger.ts        # /trigger /batch-trigger
    ├── runs.ts           # worker reporting + cancel/retry
    └── dashboard.ts      # health / tasks / runs / schedules / workers
```
