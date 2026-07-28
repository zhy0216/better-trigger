# @better-trigger/server

The **optional dashboard API** for better-trigger: a Hono HTTP server exposing
read/trigger/cancel/retry endpoints over an existing better-trigger Postgres
database. It is a tool process for `apps/web` (and external HTTP triggering) —
**not part of the execution architecture**. Workers are embedded in your own
processes via the SDK (`betterTrigger().start()`), which talk straight to
Postgres; this server runs **no orchestration loops** and no workers.

Stack: Hono + `@hono/node-server`, `pg` (Pool via `@better-trigger/db`),
`@better-trigger/core` (kernel for trigger/cancel/retry). ESM, built with tsup
(esm + cjs + dts).

## Quick start

```bash
# 1. Postgres (Docker). From the repo root:
docker compose up -d                 # starts only postgres:16 on :5432

# 2. Run the server (from packages/server)
bun run dev                          # bun --watch src/main.ts
# or, after a build:
bun run build && bun run start       # node dist/main.js
```

On boot the server applies pending migrations from `@better-trigger/db`
(drizzle-kit-generated SQL, tracked in the `drizzle.__drizzle_migrations`
journal), builds a kernel over the pool, then listens on `PORT` (default
`4848`). `SIGINT` / `SIGTERM` shut it down gracefully (close server → drain
the pool).

### Run everything in Docker

```bash
docker compose --profile server up   # postgres + the optional dashboard API
```

The `server` service is gated behind a compose **profile** so the default
`docker compose up` only brings up Postgres (the common setup is Postgres in
Docker, your app — with its embedded workers — on the host).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/better_trigger` | Postgres connection string |
| `PORT` | `4848` | HTTP listen port |
| `BETTER_TRIGGER_API_KEY` | _(unset)_ | When set, every `/api/v1/*` call (except `/health`) requires `Authorization: Bearer <key>`. Unset = local mode, no auth. |

CORS is open (`*`) for local tooling.

## API

All endpoints live under `/api/v1`, speak camelCase JSON, and travel dates as
ISO-8601 strings. Request/response types are the authoritative ones in
`packages/server/src/types.ts` (re-exported from the package root).

### Trigger API (dashboard / external HTTP)

| Method · Path | Body → Response |
|---|---|
| `POST /trigger` | `{ taskId, payload, options? }` → `{ runId, idempotent }` (404 if task unregistered) |
| `POST /batch-trigger` | `{ items }` → `{ runIds }` |

`options`: `{ delay?, idempotencyKey?, priority?, concurrencyKey?, env? }`.

App code normally triggers through the SDK instead (`trigger.trigger(...)`,
straight to Postgres) — this HTTP path exists for the dashboard and for
non-TypeScript callers.

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

Errors use a uniform envelope: `{ error: { code, message } }`. Kernel error
codes map to statuses — `400 bad_request`, `404 not_found` / `task_not_found`,
`409 run_not_running` / `stale_lease` / `conflict` (e.g. retrying a run that
is not terminal) — everything else is `500 internal_error`.

## Layout

```
src/
├── main.ts               # process entry: pool → migrate → createKernel → createApp → serve
├── index.ts              # library surface (createApp, createPool/migrate/schema, REST types)
├── app.ts                # Hono assembly + uniform error handler (kernel code → status)
├── middleware.ts         # bearer auth + CORS
├── types.ts              # dashboard REST request/response types
├── stats.ts              # task aggregations (percentile_cont, trend buckets)
└── routes/
    ├── trigger.ts        # /trigger /batch-trigger
    ├── runs.ts           # cancel/retry
    └── dashboard.ts      # health / tasks / runs / schedules / workers
```
