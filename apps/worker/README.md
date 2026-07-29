# @better-trigger/worker

The **worker daemon**: the one process that owns Postgres. It imports your task
modules, executes runs with the replay executor, runs the orchestrator loops
(waits / cron / lease reaper / offline markers), and serves the HTTP API that
the `better-trigger` SDK and `apps/web` talk to.

Applications never connect to the database — they hold `betterTrigger({ url })`
and speak HTTP to this.

Stack: Hono + `@hono/node-server`, `pg` (Pool via `@better-trigger/db`),
`@better-trigger/kernel` (the durable engine), `better-trigger` (task handle
shape + the executor storage). ESM, built with tsup (esm + cjs + dts).

## Quick start

```bash
# 1. Postgres (Docker). From the repo root:
docker compose up -d postgres        # postgres:16 on :5432

# 2. Run the daemon
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun better-trigger-worker --tasks ./src/tasks.ts
```

On boot it imports the `--tasks` modules, applies pending migrations from
`@better-trigger/db` (drizzle-kit-generated SQL, tracked in the
`drizzle.__drizzle_migrations` journal), registers itself and its tasks, starts
the claim + orchestrator loops, then listens on `PORT` (default `4848`).
`SIGINT` / `SIGTERM` shut it down gracefully: stop claiming → drain in-flight
runs → stop the loops → close the server → drain the pool.

The daemon `import()`s your task modules, so **TypeScript entries require a TS
runtime** — run it under `bun` (as above) or `tsx`, or point `--tasks` at
compiled JavaScript.

### Node shapes

`--tasks` and `--no-serve` are independent:

| Command | Role |
|---|---|
| `better-trigger-worker --tasks ./tasks.ts` | all-in-one: executes + serves (default) |
| `better-trigger-worker` | API + dashboard only; runs the lease reaper + offline markers, but **not** cron/waits/claim |
| `better-trigger-worker --tasks ./tasks.ts --no-serve` | executor-only node |

Run any number of daemons against one database — every claim and scan uses
`FOR UPDATE SKIP LOCKED`, so there is no leader election.

### Task loading

Every export of a `--tasks` module that looks like a `task()` handle is
registered, including handles inside exported arrays:

```ts
export const hello = task("hello", async () => "hi");
export const allTasks = [hello, onboarding];   // also works
```

`--tasks` is repeatable and accepts comma-separated paths. Duplicate task ids
across modules are an error unless they are literally the same handle.

## CLI

```
--tasks <path>           Module exporting task() handles (repeatable / comma-separated)
--port <n>               HTTP port                    (env PORT, default 4848)
--concurrency <n>        Concurrent execution slots   (env BETTER_TRIGGER_CONCURRENCY, default 5)
--name <s>               Worker name shown in the dashboard
--lease-ms <n>           Claim lease duration         (default 60000)
--timer-interval-ms <n>  Wait-due scan interval       (default 1000)
--cron-interval-ms <n>   Cron scan interval           (default 1000)
--reaper-interval-ms <n> Expired-lease reap interval  (default 10000)
--database-url <s>       Postgres connection string   (env DATABASE_URL)
--no-migrate             Skip applying migrations at boot
--no-serve               Execute without serving HTTP
-h, --help               Show this help
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/better_trigger` | Postgres connection string |
| `PORT` | `4848` | HTTP listen port |
| `BETTER_TRIGGER_CONCURRENCY` | `5` | Concurrent execution slots |
| `BETTER_TRIGGER_API_KEY` | _(unset)_ | When set, every `/api/v1/*` call (except `/health`) requires `Authorization: Bearer <key>`. Unset = local mode, no auth. |
| `BETTER_TRIGGER_VERSION` | _(hashed)_ | Code version reported on registration; defaults to a hash of the task ids + cron config |

CORS is open (`*`) for local tooling.

## API

All endpoints live under `/api/v1`, speak camelCase JSON, and travel dates as
ISO-8601 strings. Request/response types are the authoritative ones in
`apps/worker/src/types.ts` (re-exported from the package root); the shapes the
SDK also parses are aliases of the read models in `@better-trigger/core`.

### Trigger API

| Method · Path | Body → Response |
|---|---|
| `POST /trigger` | `{ taskId, payload, options? }` → `{ runId, idempotent }` (404 if task unregistered) |
| `POST /batch-trigger` | `{ items }` → `{ runIds }` |

`options`: `{ delay?, idempotencyKey?, priority?, concurrencyKey?, env? }`.

### Run API

| Method · Path | Response |
|---|---|
| `GET /runs/:id/record` | `RunRecord` — the run row alone; what SDK polling loops hit |
| `GET /runs/:id/result?timeoutMs=&pollMs=` | `{ status, output?, error? }` — long-polls to a terminal state (server-side wait capped at 30s; the client loops until its own deadline) |
| `POST /runs/:id/cancel` | `{ ok }` |
| `POST /runs/:id/retry` | `{ runId }` (failed/canceled only; creates a fresh run) |

### Dashboard API

| Method · Path | Response |
|---|---|
| `GET /health` | `{ ok, version }` (always open, no auth) |
| `GET /tasks` | `{ tasks: TaskSummary[] }` (runs24h, p50/p95, successRate, 12×2h trend) |
| `GET /runs?env=&taskId=&status=&limit=&cursor=` | `{ runs: RunSummary[], nextCursor }` (keyset on `created_at + id`) |
| `GET /runs/:id` | `{ run, steps, waits, logs }` (logs capped at 1000) |
| `GET /schedules` | `{ schedules: ScheduleSummary[] }` |
| `PATCH /schedules/:id` | `{ enabled }` → `{ ok }` (re-computes `nextRunAt` when enabling) |
| `GET /workers` | `{ workers: WorkerSummary[] }` |

Errors use a uniform envelope: `{ error: { code, message } }`. Kernel error
codes map to statuses — `400 bad_request`, `404 not_found` / `task_not_found`,
`409 run_not_running` / `stale_lease` / `conflict` (e.g. retrying a run that
is not terminal) — everything else is `500 internal_error`. The SDK maps the
kernel codes back onto `KernelError` client-side.

> **Error-code drift vs v1**: retrying a run that is not terminal now answers
> `409 conflict` (v1 said `400 invalid_state`), and triggering an unknown task
> uses code `task_not_found` (404). The dashboard (`apps/web`) tolerates both
> the old and new shapes.

## Layout

```
src/
├── main.ts               # daemon entry: parse argv → load tasks → migrate → kernel → runtime → serve
├── index.ts              # library surface (createApp, loadTasks, runtime, Executor, REST types)
├── loader.ts             # --tasks module import + TaskHandle collection
├── runtime.ts            # register → claim slots → heartbeat → orchestrator loops
├── executor.ts           # replay executor (seq counter, step memoization, suspend, fencing)
├── app.ts                # Hono assembly + uniform error handler (kernel code → status)
├── middleware.ts         # bearer auth + CORS
├── types.ts              # REST request/response types
├── stats.ts              # task aggregations (percentile_cont, trend buckets)
└── routes/
    ├── trigger.ts        # /trigger /batch-trigger
    ├── runs.ts           # cancel / retry / record / result
    └── dashboard.ts      # health / tasks / runs / schedules / workers
```
