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
the claim + orchestrator loops, then listens on `PORT` (default `4848`) at
`--host` (default `127.0.0.1` — reachable from this machine only).
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
--host <addr>            Bind address                 (env BETTER_TRIGGER_HOST, default 127.0.0.1)
--allow-unauthenticated  Permit a non-loopback --host without an API key
--cors-origin <origin>   Extra browser origin allowed to call the API
                         (repeatable / comma-separated, `*` = any)
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
| `BETTER_TRIGGER_HOST` | `127.0.0.1` | Bind address (same as `--host`). Loopback by default |
| `BETTER_TRIGGER_ALLOW_UNAUTHENTICATED` | _(unset)_ | `1`/`true` = same as `--allow-unauthenticated` |
| `BETTER_TRIGGER_CORS_ORIGIN` | _(unset)_ | Extra browser origins allowed to call the API, comma-separated (same as `--cors-origin`) |
| `BETTER_TRIGGER_CONCURRENCY` | `5` | Concurrent execution slots |
| `BETTER_TRIGGER_BODY_LIMIT` | `1048576` (1 MiB) | Max request body in bytes; over it the API answers `413 payload_too_large` |
| `BETTER_TRIGGER_MAX_BATCH` | `500` | Max items in one `batchTrigger`; over it `400 bad_request` — split the fan-out |
| `BETTER_TRIGGER_MAX_PAYLOAD_BYTES` | `262144` (256 KiB) | Max serialized payload per run; over it `400 bad_request` |
| `BETTER_TRIGGER_API_KEY` | _(unset)_ | When set, every `/api/v1/*` call (except `/health`) requires `Authorization: Bearer <key>`. Unset = local mode, no auth. |
| `BETTER_TRIGGER_VERSION` | _(hashed)_ | Code version reported on registration; defaults to a hash of the task ids + cron config |

### Network exposure

The daemon binds `127.0.0.1`, so out of the box only this machine can reach it.
`--host 0.0.0.0` (or any non-loopback address) puts an API that triggers your
tasks and returns run payloads on the network, so it **refuses to start**
without `BETTER_TRIGGER_API_KEY` — pass `--allow-unauthenticated`, or set
`BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=1` where no CLI flags can be added (a
container: the image already sets `BETTER_TRIGGER_HOST=0.0.0.0`), to say the
exposure is intended anyway:

```bash
better-trigger-worker --host 0.0.0.0                            # error: no API key
BETTER_TRIGGER_API_KEY=secret better-trigger-worker --host 0.0.0.0
better-trigger-worker --host 0.0.0.0 --allow-unauthenticated    # boots, warns loudly
# same, for a container that cannot take flags
BETTER_TRIGGER_HOST=0.0.0.0 BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=1 better-trigger-worker
```

In Docker the split is: the container binds `0.0.0.0` (the image sets
`BETTER_TRIGGER_HOST`, otherwise the published port reaches nothing) and the
host publishes to loopback — `docker-compose.yml` maps `127.0.0.1:4848:4848`.

Running without a key stays supported — it is the local default — but the
daemon says so on boot, naming the address it is bound to, so "no auth" is a
state you know about rather than one you forgot. When a key *is* set, the bearer
token is compared with `crypto.timingSafeEqual` after a length check, so a
wrong key costs the same time no matter how much of it was right.

### CORS

Binding loopback keeps the network out, but not the browser: a page the user
visits can still send a cross-origin request to `http://localhost:4848`, and
with `Access-Control-Allow-Origin: *` on an unauthenticated API that page could
trigger tasks and read run payloads. So only the dashboard's own origins are
allowed by default — **http/https on `localhost` / `127.0.0.0/8` / `[::1]`, any
port** (the vite dev port is not fixed). Anything else gets no
`Access-Control-Allow-Origin` header and the browser drops the response.

`--cors-origin` adds origins explicitly; it is repeatable and accepts
comma-separated values, and `*` opts back into allowing everything:

```bash
better-trigger-worker --cors-origin https://ops.example.com
better-trigger-worker --cors-origin https://a.example.com,https://b.example.com
BETTER_TRIGGER_CORS_ORIGIN=https://ops.example.com better-trigger-worker
```

Origins are compared after parsing (scheme + host + port), so
`http://localhost.evil.com` is not `localhost`. Non-browser callers — the SDK,
`curl` — send no `Origin` and are unaffected: CORS only decides what a browser
hands back to a page, never whether the daemon serves the request.

That last clause is why the allowlist is only half of it. A cross-origin POST is
a **simple request** — one the browser sends with no preflight at all — as long
as its `Content-Type` is `text/plain`, `application/x-www-form-urlencoded` or
`multipart/form-data`. Such a request reaches the route and runs the task; the
browser only hides the response. So every route that reads a body requires
`Content-Type: application/json` (parameters such as `; charset=utf-8` are
fine) and answers `400 bad_request` otherwise: asking for that media type is
what forces a preflight, and the preflight is where the allowlist refuses.
Body-less POSTs (`/runs/:id/cancel`, `/runs/:id/retry`) announce nothing and are
untouched. The SDK and the dashboard already send `application/json`; `curl`
needs it spelled out, since `-d` defaults to form encoding:

```bash
curl -X POST http://localhost:4848/api/v1/trigger \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"send-email","payload":{}}'
```

### Request limits

One request should not be able to take the daemon down — and a mistyped loop
does the same damage as a hostile caller. Three caps, all overridable through
the environment variables in the table above:

| Cap | Default | Refusal |
|---|---|---|
| Request body | 1 MiB | `413 payload_too_large` |
| `batchTrigger` items | 500 | `400 bad_request` |
| Serialized payload per run | 256 KiB | `400 bad_request` |

The body cap is enforced by middleware before anything buffers the request, so
a 500MB POST never reaches the heap. The batch cap is about the transaction:
every item is two INSERTs inside **one** transaction, so an unbounded array
parks a long write transaction on top of the queue rows and stalls every claim
behind it — **fan-outs larger than the cap have to be split into batches by the
caller**:

```ts
for (let i = 0; i < items.length; i += 500) {
  await myTask.batchTrigger(items.slice(i, i + 500));
}
```

The payload cap is the usual durable-execution advice: a payload is copied into
`runs.payload`, read back on every replay and rendered in the dashboard, so keep
large objects in object storage and pass a reference. Raising the caps is one
env var each, but the transaction and the heap behind them do not change:

```bash
BETTER_TRIGGER_BODY_LIMIT=4194304 \
BETTER_TRIGGER_MAX_BATCH=2000 \
BETTER_TRIGGER_MAX_PAYLOAD_BYTES=1048576 better-trigger-worker
```

A value that is absent, zero, negative or unparseable falls back to the default
rather than switching the cap off.

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

Errors use a uniform envelope: `{ error: { code, message } }` (plus a
`requestId` on one branch, below). Kernel error codes map to statuses —
`400 bad_request`, `404 not_found` / `task_not_found`, `409 run_not_running` /
`stale_lease` / `conflict` (e.g. retrying a run that is not terminal),
`413 payload_too_large` (body over `BETTER_TRIGGER_BODY_LIMIT`, refused by
middleware before the route runs) — everything else is `500 internal_error`.
The SDK maps the kernel codes back onto `KernelError` client-side.

> **Error-code drift vs v1**: retrying a run that is not terminal now answers
> `409 conflict` (v1 said `400 invalid_state`), and triggering an unknown task
> uses code `task_not_found` (404). The dashboard (`apps/web`) tolerates both
> the old and new shapes.

### The 500 body forks on `NODE_ENV`

A non-`KernelError` message is whatever pg or the connection layer produced:
table, column and constraint names, sometimes a host or a connection-string
fragment. Locally that detail is exactly what you want; once the daemon is
shared (the "point several machines at one Postgres" deployment) it is a free
schema leak. So under `NODE_ENV=production` the response gets a fixed message
plus a `requestId`, and the real error goes only to the server log under that
same id:

| `NODE_ENV` | 500 body | Server log line |
|---|---|---|
| anything else | `{ error: { code: 'internal_error', message: <the real message> } }` | `[server] unhandled error: …` |
| `production` | `{ error: { code: 'internal_error', message: 'internal error', requestId: 'req_…' } }` | `[server] unhandled error (req_…): …` |

`requestId` exists only on that production branch — one id per failed request,
in the response *and* in the log, so a bug report that quotes the id is enough
to `grep req_… ` the daemon's output and get the stack. Kernel-code responses
(4xx / 409 / 413) are byte-identical in both modes: those messages are ours,
written for the caller, and are never redacted. The SDK reads the id back out
as `HttpError.requestId` (and appends it to `err.message`).

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
