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
  bunx --bun @better-trigger/worker --tasks ./src/tasks.ts
```

The registry package is **`@better-trigger/worker`** (its binary is
`better-trigger-worker`), so outside a repo checkout run it by package name —
`npx @better-trigger/worker ...` works too. Inside this repo's workspace the
bare bin `bunx --bun better-trigger-worker` resolves as well; the CI
clean-install smoke (O4) installs the packed tarball in a temp directory and
runs `better-trigger-worker --help`, so "workspace works, registry package
doesn't" cannot ship.

`docker compose up -d` (no service name) skips both steps: it also starts this
daemon in a container with `--tasks /app/examples/basic/src/tasks.ts`, published
on `127.0.0.1:4848`.

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

### Serving the dashboard

The worker **embeds the built dashboard** and serves it from the same port as
the API (O3). The build pipeline (`scripts/copy-public.mjs`, part of `bun run
build`) builds `apps/web` and copies its `dist` into `dist/public`, which
travels with the published package and the Docker image. At runtime:

- `/` and `/index.html` → the dashboard shell (`Cache-Control: no-cache`, so
  every load revalidates and a daemon restart always serves the new bundle).
- `/runs/…`, `/schedules`, … → SPA deep links answer `index.html` too, so a
  refresh of a bookmarked run page never 404s.
- `/assets/*` → the hashed build files, served `immutable` for a year — the
  content-hash names are what makes "no stale bundle after restart" work.
- `/api/v1/*` and any other `/api*` path are untouched: API routes answer as
  before, unknown ones keep the JSON 404.

Because the dashboard is same-origin, production needs one port and no CORS
configuration, and the built client talks to the origin it was loaded from —
no `VITE_BT_API_URL` needed. A build without the dashboard (`dist/public`
missing, e.g. a source checkout that has not run the web build) behaves
exactly as before: non-API paths answer the JSON 404. For dashboard
development, run Vite standalone (see `apps/web/README.md`).

`--no-serve` (executor-only) starts no HTTP server, so it serves nothing —
static hosting only exists on the same surface as the API.

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
--retention <duration>   Turn ON the retention GC loop ("30d", "72h")
--gc-interval-ms <n>     Retention GC interval        (default 3600000)
--pin-code-version       Claim only runs whose code version this process serves
                         (env BETTER_TRIGGER_PIN_CODE_VERSION)
--stranded-interval-ms <n>
                         Stranded-run scan interval   (default 30000)
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
| `BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES` | `1048576` (1 MiB) | Max TOTAL serialized payload across one `batchTrigger`; over it `400 bad_request` — split the fan-out (500 items at the per-item cap would be 128 MiB in one write tx) |
| `BETTER_TRIGGER_MAX_PAYLOAD_BYTES` | `262144` (256 KiB) | Max serialized payload per run; over it `413 payload_too_large` |
| `BETTER_TRIGGER_MAX_STEPS` | `10000` | Cap on a run's replayed step ledger. A run past the cap is claimed but marked truncated and fails with a **non-retryable** AbortError — replaying a truncated ledger would silently skip steps, so split the task with `continueAsNew` before it grows this large. `0` = unlimited |
| `BETTER_TRIGGER_POOL_MAX` | _derived_ | Business-pool connection max. Defaults to `BETTER_TRIGGER_CONCURRENCY + 8` (headroom for the orchestrator loops, heartbeat, waiter sweep and HTTP slack). Raise it when `better_trigger_pool_checkout_timeouts_total` climbs |
| `BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS` | `10000` | Business-pool checkout / connect timeout in ms. A saturated pool answers a checkout with an error after this instead of queueing it forever; each one is counted on `better_trigger_pool_checkout_timeouts_total`. `0` = a checkout waits forever (pg's default) |
| `BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS` | `30000` | Server-side statement timeout in ms, sent as `statement_timeout` in the connection startup packet — PostgreSQL itself cancels a query that runs longer and returns the connection to the pool. `0` = off |
| `BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION` | _(unset)_ | Set to `1` to make a stray `unhandledRejection` fatal (exit 1, like an `uncaughtException`). Default off: a stray rejection is logged and counted on `better_trigger_unhandled_rejections_total` while the daemon keeps serving — it is almost always a non-awaited promise in **task code**, and one bad task promise should not take down every unrelated in-flight run |
| `BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES` | `262144` (256 KiB) | Max serialized output/error per step row; over it the step records as **failed** with a `SerializationError` diagnostic and the run fails |
| `BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES` | `262144` (256 KiB) | Max serialized run output; over it the run fails `413 payload_too_large` |
| `BETTER_TRIGGER_ERROR_MAX_BYTES` | `65536` (64 KiB) | Max serialized error record (message/name/stack); a larger one is stored as a `SerializationError` stub so the failure itself still lands |
| `BETTER_TRIGGER_LOG_DATA_MAX_BYTES` | `16384` (16 KiB) | Max serialized `data` on one log line; an over-limit line keeps its message and stores `{ omitted: true, reason }` in `data` |
| `BETTER_TRIGGER_LOG_BATCH_MAX_BYTES` | `262144` (256 KiB) | Max serialized payload of one log INSERT; a flush over it is split into more statements |
| `BETTER_TRIGGER_STATS_TTL_MS` | `10000` | Cache TTL for `/tasks` stats (per namespace); `0` disables the cache |
| `BETTER_TRIGGER_API_KEY` | _(unset)_ | When set, every `/api/v1/*` call (except `/health`) requires `Authorization: Bearer <key>`. Unset = local mode, no auth. The value may carry a `@<date>` expiry suffix (e.g. `sk-prod-abc@2027-01-01`): past the date the key answers `401 key_expired` |
| `BETTER_TRIGGER_API_KEYS` | _(unset)_ | Additional bearer keys, comma-separated, each optionally carrying the same `@<date>` expiry suffix. ANY configured key authenticates — this is the rotation mechanism (see "Network exposure") |
| `BETTER_TRIGGER_RATE_LIMIT_RPS` | `50` | Per-key per-endpoint token-bucket rate on `trigger` / `batch-trigger` / `retry` / `cancel` (tokens per second). `0` disables the per-key bucket |
| `BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS` | `200` | Per-endpoint token-bucket rate over all keys (tokens per second). `0` disables the global bucket. In-memory per process — see "Network exposure" for the multi-daemon boundary |
| `BETTER_TRIGGER_RATE_LIMIT_READ_RPS` | `200` | Per-key token-bucket rate across the read surface — every `/api/v1` read: `/runs/:id/record`, `/runs/:id/result`, `/runs`, `/tasks`, `/schedules`, `/workers`, `/metrics` (tokens per second). Deliberately loose (see "Rate limiting"); `0` disables the per-key read bucket |
| `BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS` | `1000` | Token-bucket rate over all keys across the whole read surface (tokens per second). `0` disables the global read bucket. In-memory per process, like the write buckets |
| `BETTER_TRIGGER_RATE_LIMIT_BURST` | _larger write rate above_ | Token-bucket capacity (max burst) for both buckets; negative or unparseable values fall back to the default, `0` is honoured |
| `BETTER_TRIGGER_PIN_CODE_VERSION` | _(unset)_ | `1`/`true` = same as `--pin-code-version` |
| `BETTER_TRIGGER_VERSION` | _(build identity)_ | Code version reported on registration. Defaults to the build identity (`0.1.0+<git sha>`, the same value `/health` reports; version-only outside git); setting it overrides the worker-level version AND every per-task version at once |

### Code versions and redeploys

Replay keys steps **by position**, so editing a `run()` while runs are in flight
is the one change that can corrupt a ledger: a `ctx.step()` inserted at seq 1
meets the `wait` row the old code wrote there. A long `ctx.wait` makes this
routine — a suspended run's ledger can outlive several deploys.

Every task therefore carries a **code version**: a hash of its id, cron config
and `run()` body source (`BETTER_TRIGGER_VERSION` overrides it for all tasks at
once). It is per task, not per deploy, so editing one task does not move the
version of the runs of another. Registration stamps it on
`tasks.latest_code_version`, and every run created from then on carries it on
`runs.code_version` — which is what makes "which code shape wrote this ledger"
answerable after the fact.

`--pin-code-version` turns that record into a rule: **a claim only picks up runs
stamped with the version this process serves for that task.** A run whose task
was edited mid-flight stays queued for a worker that can still replay it,
instead of being handed to code that will drift.

**Build provenance (O4).** `workers.code_version` — what the dashboard's
workers page and `/metrics` report as this process's version — is the **build
identity**: the same `0.1.0+<git-sha>` `/health` and `better_trigger_build_info`
report (version-only for builds outside a git checkout, like the Docker image
built without a `GIT_SHA` build arg). That is a *deploy* value, deliberately
not derived from task source. The *replay* value is the per-task
`tasks.latest_code_version` stamped on `runs.code_version`, which is what
`--pin-code-version` matches on — editing a `run()` moves it without churning
the build identity, and the step fingerprint makes the ledger itself detect
replay drift. `BETTER_TRIGGER_VERSION` overrides **both** at once: set it to
your own git sha / image tag to name deploys exactly as your pipeline does.

That is a real trade, not a free win:

| | Default (off) | `--pin-code-version` |
|---|---|---|
| Redeploy with runs in flight | New build takes them over. Matching ledgers replay fine; drifted ones warn (`replay:'lenient'`) or fail (`'strict'`) | New build ignores them. They wait |
| Old build never returns | Runs finish, possibly on a drifted ledger | Runs wait **forever** |
| Rolling deploy | Nothing to do | Keep one worker on the old build until its runs drain |

The waiting is not silent: with pinning on, the daemon scans for runs due,
unclaimed, and pinned to a version no online worker serves, and reports them on
`better_trigger_stranded_runs` (plus a log line whenever the picture changes).
Alert on that gauge — under pinning it is the failure mode.

Either way, prefer `replay: 'strict'` on tasks whose ledgers matter: it turns a
drifted replay into a terminal `AbortError` instead of a run that completes
while reporting success for a step whose body never executed.

### Notification fast-path (PF2)

The daemon keeps one **dedicated LISTEN connection** (`pg.Client`, never a pool
checkout) on a single `bt` channel. The kernel's write paths — trigger /
batch-trigger / child creation / wait resume / cron fire / complete / fail /
cancel / retry / reaper — run `SELECT pg_notify(...)` as the last statement of
their transaction, so a notification is only delivered when the transaction
actually commits. Two payload shapes, ids only:

- `{ type: 'work' }` — something became claimable. The daemon wakes its idle
  claim loops immediately instead of waiting out the 300ms→2s idle backoff.
- `{ type: 'terminal', runId, projectId, env }` — a run reached a terminal
  state. The daemon's **in-process waiter registry** settles every `result()`
  waiter for that run at once.

`result()` waiters (HTTP `/runs/:id/result` and in-process `RunHandle.result()`)
go through the registry: N waiters share one 1s sweep (`WHERE id = ANY(...)`)
plus terminal notifications, instead of N independent ~4 QPS poll loops. The
kernel's `waitForResult` poll remains the fallback everywhere.

Notifications are a **latency optimization, never a correctness source**: every
consumer keeps its polling fallback, the LISTEN connection re-establishes
itself with backoff (and re-issues LISTEN) after a drop, and terminal
notifications are ignored for namespaces this daemon does not serve. The
relevant metrics are `notifications_received_total`, `listen_reconnects_total`,
`waiter_resolutions_total`, `waiter_timeouts_total` and `claim_wakes_total`.

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

#### Multiple keys and rotation (O6)

`BETTER_TRIGGER_API_KEY` keeps its single-key meaning, and
`BETTER_TRIGGER_API_KEYS` adds more: a comma-separated list of keys, ANY of
which authenticates (each compared in constant time). Each entry — in either
variable — may carry an expiry suffix: `sk-prod-abc@2027-01-01` (or any date
`new Date` accepts). Past the date the key answers `401` with code
`key_expired` — distinct from the wrong-key `unauthorized`, so the audit log
says *why* a credential stopped working. A key that merely contains `@` is
kept whole; only a trailing `@<parseable-date>` is treated as expiry.

Rotation is coexistence, and the coexistence is the mechanism:

```bash
# 1. add the new key alongside the old one (both authenticate now)
BETTER_TRIGGER_API_KEY=sk-old-aaaaaaaa \
BETTER_TRIGGER_API_KEYS=sk-new-bbbbbbbb better-trigger-worker --host 0.0.0.0

# 2. wait for the old key's in-flight / long-polling requests to drain
# 3. remove the old key — the new one keeps working, the old one stops
BETTER_TRIGGER_API_KEY=sk-new-bbbbbbbb better-trigger-worker --host 0.0.0.0
```

Old requests are never interrupted mid-flight (the key is only checked at
request start) and the old credential stops being accepted the moment it
leaves the config — nothing keeps it around after removal. For scheduled
rotation, set the suffix when the key is introduced: it expires on its own,
and the audit trail shows `key_expired` for requests that tried it afterwards.

#### Rate limiting (O6)

The four endpoints that create or control runs — `POST /trigger`,
`/batch-trigger`, `/runs/:id/cancel`, `/runs/:id/retry` — are token-bucket
limited so a hostile or misconfigured client cannot create runs without bound.
Two buckets are consumed per request: **per key** (one noisy client cannot
starve its neighbours) and **per endpoint** (even several keys together cannot
drive the endpoint past the overall cap). Over the limit is `429` with the
standard envelope, `{ error: { code: 'rate_limited', message } }`.

**With no API key configured, the per-key dimension falls back to the source
address** (p2-31): the bucket is keyed by the socket peer IP, so one local
process exhausting the rate cannot starve another. The address is the TCP
peer, never `X-Forwarded-For` (spoofable). Loopback shares one address, so
several local processes on one host still contend for the same per-IP bucket —
the global bucket remains the fleet-wide backstop.

Knobs (see the env table): `BETTER_TRIGGER_RATE_LIMIT_RPS` (per key per
endpoint, default 50/s), `BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS` (per endpoint
over all keys, default 200/s), `BETTER_TRIGGER_RATE_LIMIT_BURST` (bucket
capacity, default the larger of the two rates). `0` disables that bucket —
e.g. set both to `0` for the pre-O6 behaviour.

**Reads are bucketed too, but loosely (p1-14).** Every `/api/v1` read — `GET
/runs/:id/record`, `/runs/:id/result`, `/runs`, `/tasks`, `/schedules`,
`/workers`, `/metrics`, and any unknown `/api/v1` path — draws from a shared
`read` bucket: per key (default `BETTER_TRIGGER_RATE_LIMIT_READ_RPS`, 200/s)
and over all keys (`BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS`, 1000/s). The
defaults are loose on purpose: a single read can be a DB query (a `/result`
long-poll even parks a waiter), so on a network-exposed daemon an unbounded
read storm starves the claim/heartbeat loops on the shared business pool —
but a dashboard legitimately polls `/tasks` and `/runs` every few seconds,
and that must never be throttled. The read bucket exists to bound an attack,
not a dashboard. Set both read knobs to `0` to restore unlimited reads.
`/health`, OPTIONS preflights and the dashboard's static assets (outside
`/api/v1/`) are never limited.

Deliberately NOT bucketed: **IP** (behind a reverse proxy — the deployment
this feature exists for — the socket address is the proxy's, and
`X-Forwarded-For` is a header any client can set, so it is never trusted for
enforcement or auditing) and **task** (the caller is already keyed; the
per-key cap bounds what one caller can create regardless of task).

The buckets are **in-memory and per process**. Several daemons behind a load
balancer each keep their own, so this is a backstop per process rather than an
exact fleet-wide meter — for an exact fleet-wide cap, put the limit at the
reverse proxy (where per-IP limiting is also honest). A concurrency cap
(max in-flight creations) was deliberately not added: the bucket already
bounds the creation *rate*, which is the acceptance criterion, and a second
independent cap would only add configuration surface.

#### Audit log (O6)

Every `/api/v1` request (except `/health` — polled by every healthcheck — and
OPTIONS preflights) writes one structured line to stdout:

```
[audit] {"audit":true,"ts":"…","requestId":"req_ab12…","method":"POST",
         "path":"/api/v1/trigger","endpoint":"trigger","key":"key_cd34ef56…",
         "caller":"10.0.0.7","taskIds":["send-email"],"runIds":["run_…"],
         "status":200,"result":"accepted","reason":null}
```

- `requestId` correlates the line with the response's `x-request-id` header
  and with a production 500 body, which carries the same id.
- `key` is a sha256 fingerprint of the matched API key, never the key.
- `caller` is the TCP peer address; behind a reverse proxy it is the proxy's
  address, and `X-Forwarded-For` is deliberately not recorded (see above).
- `taskIds` / `runIds` come from the request and response bodies of the four
  write endpoints (capped at 10 ids each). The **payload is never read into
  the line** — it is the one thing an audit line must not carry — and the
  `Authorization` header never appears either.
- Rejections are recorded too: `status`, `result: "rejected"` and `reason`
  (the error code — `unauthorized`, `key_expired`, `rate_limited`,
  `bad_request`, …). The body of a rejected request is not parsed, so an
  oversized one is not buffered just to audit it.

The log is stdout, not a database table: an audit table would grow without
bound on the same Postgres that stores runs. Pipe stdout to any log collector;
retention of the lines is the collector's job.

#### TLS, reverse proxy and database isolation

The daemon speaks plain HTTP — terminate TLS at the reverse proxy
(nginx/Caddy/Traefik/ALB) in front of it, which is also where to put
client-IP-aware rate limits and access logging. Do not expose the daemon's
port directly to the internet. The database is a separate boundary: **only the
daemon** may reach Postgres — give `DATABASE_URL` no public route, keep the
port closed to everything but the daemon's network (and your migration
runner), and never ship the connection string to clients. The SDK never opens
a database connection, so "app may not touch the DB" is a network rule, not a
code rule.

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
does the same damage as a hostile caller. Several caps, all overridable
through the environment variables in the table above:

| Cap | Default | Refusal |
|---|---|---|
| Request body | 1 MiB | `413 payload_too_large` |
| `batchTrigger` items | 500 | `400 bad_request` |
| Total serialized payload per `batchTrigger` | 1 MiB | `400 bad_request` |
| Serialized payload per run | 256 KiB | `413 payload_too_large` |
| Serialized step output / error | 256 KiB | step records **failed** with a `SerializationError` diagnostic; the run fails |
| Serialized run output | 256 KiB | `413 payload_too_large`; the run fails |
| Serialized error record | 64 KiB | stored as a `SerializationError` stub |
| Serialized log-line `data` | 16 KiB | line kept, `data` becomes `{ omitted: true, reason }` |
| Serialized bytes per log INSERT | 256 KiB | flush split into more statements |

Values that JSON cannot represent at all — a circular structure, a BigInt, a
top-level function — are refused the same way everywhere, as
`400 serialization_error` naming the offending field (payload / output / data),
never as a raw `TypeError` that would read as a 500 (or, in the SDK, as a dead
daemon). The one deliberate exception is the error record: a run (or step)
must still land its failure even when the error text itself is enormous, so
that is degraded rather than refused.

The body cap is enforced by middleware before anything buffers the request, so
a 500MB POST never reaches the heap. The batch caps are about the transaction:
a fan-out inserts every run in ONE transaction, so an unbounded array (in item
count OR in total payload bytes) parks a long write transaction on top of the
queue rows and stalls every claim behind it. The kernel preloads the task
configs once and bulk-inserts the runs and queue rows, so a 500-item batch is
a constant handful of statements — but the caps still stand, because a long
write tx is a long write tx however few statements it took. **Fan-outs larger
than the caps have to be split into batches by the caller**:

```ts
for (let i = 0; i < items.length; i += 500) {
  await myTask.batchTrigger(items.slice(i, i + 500));
}
```

The payload/output caps are the usual durable-execution advice: a payload is
copied into `runs.payload`, re-read on every replay and rendered in the
dashboard, and a step or run output is copied into its jsonb column the same
way — so keep large objects in object storage and pass a **reference** (the
object key / URL) in the value, exactly as you would for a database column:

```ts
const key = `uploads/${ctx.run.id}`;
await putObject(key, hugeBuffer);              // object storage
await ctx.step("enrich", () => { ... });       // payload/output stay small
return { objectKey: key, rows: 123 };          // a reference, not the bytes
```

A payload or output that is over its cap fails the run with a stable
`payload_too_large` / `serialization_error` code — nothing is silently
truncated. Raising the caps is one env var each, but the transaction and the
heap behind them do not change:

```bash
BETTER_TRIGGER_BODY_LIMIT=4194304 \
BETTER_TRIGGER_MAX_BATCH=2000 \
BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES=8388608 \
BETTER_TRIGGER_MAX_PAYLOAD_BYTES=1048576 \
BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES=1048576 better-trigger-worker
```

A value that is absent, zero, negative or unparseable falls back to the default
rather than switching the cap off.

### Business pool sizing

One `pg` Pool backs the claim loops, the orchestrator loops (waits / cron /
lease reaper / offline markers), the heartbeat, the waiter registry and every
HTTP route's query. The daemon sizes it to its own work:

```
max = --concurrency + 8
```

The 8 is headroom above the execution slots: one checkout for each orchestrator
loop, the heartbeat, the waiter sweep, and slack for HTTP routes. A pool smaller
than the concurrency it serves is the failure this whole design exists to make
visible, so it is **derived, not configured** — but `BETTER_TRIGGER_POOL_MAX`
overrides it when the arithmetic does not fit your workload (e.g. many
concurrent long-polling `/result` requests).

The pool's deadlines have defaults too:

- `BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS` (default `10000`): a saturated or
  black-holed pool answers a checkout with an error after this instead of
  queueing the request forever. `0` restores pg's wait-forever default.
- `BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS` (default `30000`): sent as
  `statement_timeout` in the connection startup packet, so **PostgreSQL itself**
  cancels a query that runs longer (a queue-row lock, a slow scan) and returns
  the connection to the pool. `0` disables it.

A pool that is too small for the concurrency + loops it serves shows up as
`better_trigger_pool_checkout_timeouts_total` climbing: each checkout that
timed out is one moment the pool was saturated. A rising rate there means raise
`BETTER_TRIGGER_POOL_MAX` (or reduce `--concurrency`), before the timeouts
start rejecting work.

A rising `better_trigger_unhandled_rejections_total` is not a daemon fault: a
stray `unhandledRejection` (a promise in a task body that was never awaited)
is logged with the run context and the daemon keeps serving, so one task's
promise hygiene cannot take down every unrelated in-flight run. Set
`BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION=1` if you want fail-fast semantics.

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
| `GET /health` | `{ ok, version, sha? }` — liveness, never touches the DB (always open, no auth). `version` is the package version baked into the build — the same value the published tarball carries — and `sha` is the git commit it was built from (absent when built outside a git checkout, e.g. the Docker image). Together they make the running artifact traceable to a release **and** a commit |
| `GET /health?deep=1` | readiness: `SELECT 1` (2s deadline) + `{ db, pool: { total, idle, waiting } }`; 503 when the DB does not answer. Also open — a container healthcheck has no key. This is what the image's `HEALTHCHECK` runs. The probe runs on a **dedicated probe pool** (see below), never a business connection. |
| `GET /tasks` | `{ tasks: TaskSummary[] }` (24h-window runs24h/p50/p95/successRate/trend, all-history `lastRunAt`; cached 10s per namespace) |
| `GET /runs?env=&taskId=&status=&limit=&cursor=` | `{ runs: RunSummary[], nextCursor }` (keyset on `created_at + id`) |
| `GET /runs/:id?logsBefore=` | `{ run, steps, stepsTruncated, waits, waitsTruncated, logs, logsNextCursor }` — one snapshot; newest 200 logs by default, older pages via `logsBefore` |
| `GET /schedules` | `{ schedules: ScheduleSummary[] }` |
| `PATCH /schedules/:id` | `{ enabled }` → `{ ok }` (re-computes `nextRunAt` when enabling) |
| `GET /workers` | `{ workers: WorkerSummary[] }` |
| `GET /metrics` | Prometheus text (`text/plain; version=0.0.4`), not JSON — see below |

Point a **readiness** probe at `?deep=1`, never a **liveness** one. The deep
probe runs on its own **probe pool** (PF4): a small dedicated pool
(`max: 2`) created by `createHealthPool()`, separate from the business pool.
Its connections carry `statement_timeout=1000` (and a 1s connect timeout), so
PostgreSQL itself cancels a probe query after 1s and the connection returns to
the pool — a hung or repeatedly-failing probe can never hold a business
connection, and the 2s deadline is only the HTTP answer. Concurrent probes and
scrapes are **single-flight** (one in-flight probe per route; everyone else
shares its outcome), so a probe storm cannot pile up queued queries on the
probe pool either. `pool` in the response is still the **business** pool's
counters — that is the pool whose saturation a readiness check should see.
Embedded callers that assemble `createApp({ kernel, pool })` without a
`probePool` get the probe on the business pool instead — fine for a healthy
database, but a hung one can then hold business connections through the
probes: production deployments should run through the daemon (`main.ts` wires
a real probe pool), or pass their own `createHealthPool()` in. Liveness is the
plain `/health`, which answers without touching Postgres for exactly this
reason.

`/tasks` stats are computed over runs **created in the last 24h** (runs24h,
p50/p95, successRate, trend); `lastRunAt` is the task's most recent run over
**all history**. The response is cached per namespace for 10s
(`BETTER_TRIGGER_STATS_TTL_MS`), so the dashboard's 2s poll does not re-run
the aggregations on every tick.

**`GET /runs/:id` is one snapshot, and its pages have a hard size (PF3).** The
run row, steps, waits and logs are read inside a single `REPEATABLE READ`
transaction, so the four parts always agree — the run status you see is the
status its ledger was read under. Logs come back as the **newest 200 lines in
chronological order** (a long run's final error is on the page by default);
`logsNextCursor` carries the oldest line's id when older logs exist, and
passing it back as `?logsBefore=` fetches the previous page — repeat until the
cursor is `null`. Steps and waits are capped at the newest 500 rows each, with
`stepsTruncated` / `waitsTruncated` set when the cap cut older rows (full
pagination for them is future work). Size bound: one detail response is at
most 200 log lines (each ≤ the 16 KiB per-line `data` cap) plus 500 steps
(each ≤ the 256 KiB step output / 64 KiB error caps) plus 500 waits plus the
run record — worst case dominated by per-row caps; typical pages are a few
KiB. `logsBefore` is validated (`400 bad_request` on a non-positive integer).

### Metrics

`GET /api/v1/metrics` exposes the numbers the dashboard cannot: how deep the
queue is, whether anything is executing, and whether the loops that swallow
their errors have been swallowing them all afternoon. Everything is prefixed
`better_trigger_`.

| Metric | Type | What it answers |
|---|---|---|
| `db_up` | gauge | Did this scrape reach Postgres? When `0`, the two DB gauges below are **absent** rather than zero — "empty queue" and "unknown queue" must not look alike |
| `queue_depth{state=available\|scheduled\|claimed}` | gauge | Backlog: due-and-waiting, delayed, currently leased |
| `inflight_runs` | gauge | Runs in `running`, across every worker on this database |
| `worker_inflight_runs` | gauge | Runs executing in *this* process |
| `runs_total{outcome=completed\|failed\|suspended\|abandoned}` | counter | Throughput and outcome mix of this process — **`outcome`, not `status`; see the note below** |
| `claim_errors_total`, `claim_errors_consecutive` | counter, gauge | The "daemon looks idle but is actually failing to claim" case |
| `heartbeat_errors_total`, `heartbeat_errors_consecutive` | counter, gauge | Leases drifting towards being reaped |
| `executor_errors_total`, `fail_report_errors_total`, `log_flush_errors_total` | counter | The other best-effort catches |
| `pool_checkout_timeouts_total` | counter | Times a business-pool checkout timed out (`connectionTimeoutMillis`) — each one is a pool that was saturated at that moment. A rising rate means the pool is too small (see "Business pool sizing") |
| `reaper_recovered_total{outcome=requeued\|failed}` | counter | How much work the lease reaper had to rescue |
| `orchestrator_errors_total{loop}` | counter | Background loop iterations that threw |
| `loop_last_success_timestamp{loop}` | gauge | Epoch ms of the last tick each background loop completed without throwing. A loop whose timestamp stops advancing is **stalled** even when its error counter stays 0 — the re-entrancy guard swallowed the ticks |
| `stranded_runs` | gauge | Due runs pinned to a code version no online worker serves. `0` unless `--pin-code-version` is on — **alert on this one** |
| `stranded_runs_by_version{task_id,code_version}` | gauge | Which build has to come back. Present only while something is stranded |
| `notifications_received_total` | counter | pg_notify messages received on the `bt` channel (the notification fast-path) |
| `listen_reconnects_total` | counter | Times the LISTEN connection dropped and re-established itself |
| `waiter_resolutions_total` | counter | `result()` waiters settled by the in-process registry |
| `waiter_timeouts_total` | counter | `result()` waiters that hit their deadline (latest non-terminal status) |
| `claim_wakes_total` | counter | Times a work notification woke the idle claim loops |

Two gauges come from one SQL round trip (2s deadline), run on the same
dedicated probe pool as the health probe — a failing or hung scrape borrows a
probe connection at most, never a business one, `statement_timeout` cancels
the query server-side, and concurrent scrapes share a single in-flight probe
(single-flight); everything else is a live in-process counter, so a scrape
stays cheap. The endpoint answers `200` even with the database down —
a successful scrape reporting `db_up 0` says more than a failed scrape, and
the counters are what say how long it has been wrong.

> **`runs_total` is labelled `outcome`, and it is not `runs.status`.** The label
> carries the *executor's verdict on one execution pass*: `failed` there is an
> attempt the executor reported as failed, which the kernel may well retry, so
> `sum(runs_total{outcome="failed"})` is attempts-that-failed, not runs that
> ended failed. `suspended` is a pass that parked on a wait (the run is alive),
> `abandoned` is a claim handed back after the lease was lost — neither is a
> `runs.status` value at all. It is also **per process and per lifetime**: a
> restart resets it, and a run retried on another daemon is counted there.
> For "how many runs are in status X right now", query the `runs` table (or
> read the dashboard's `/tasks` stats); there is deliberately no metric for it,
> because that is an aggregate over unbounded history rather than a counter,
> and it would cost a table scan on every scrape.

Unlike `/health`, this path is **not** exempt from auth: queue size and
throughput describe your workload, and a scraper has somewhere to put a bearer
token. Set `BETTER_TRIGGER_API_KEY` and it closes with the rest of the API.

Errors use a uniform envelope: `{ error: { code, message } }` (plus a
`requestId` on one branch, below). Kernel error codes map to statuses —
`400 bad_request` / `serialization_error` (a value JSON cannot represent, or a
shape the kernel refuses), `404 not_found` / `task_not_found`, `409
run_not_running` / `stale_lease` / `conflict` (e.g. retrying a run that is not
terminal), `413 payload_too_large` (body over `BETTER_TRIGGER_BODY_LIMIT`
refused by middleware before the route runs, or a payload/output over its
serialized cap) — everything else is `500 internal_error`. The SDK maps the
kernel codes back onto `KernelError` client-side.

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
    ├── dashboard.ts      # health / tasks / runs / schedules / workers
    └── metrics.ts        # /metrics (Prometheus text)
```
