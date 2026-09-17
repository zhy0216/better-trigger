# better-trigger

A TypeScript-first, PostgreSQL-backed durable execution runtime. Run the worker
as a small standalone **daemon** (the default), or embed the same runtime in an
existing long-lived Node/Bun application. **No Redis, no ClickHouse** — Postgres
is the only infrastructure.

- **The worker runtime owns Postgres** — queue, orchestrator loops (timers /
  cron / lease reaper) and the replay executor live in `@better-trigger/worker`.
  Run it as a daemon or embedded host; N processes against one database
  coordinate via `FOR UPDATE SKIP LOCKED` — no leader election.
- **Embedded when one process is the product** —
  `createEmbeddedRuntime({ tasks, databaseUrl })` starts those same loops in your app and
  connects the normal SDK client through an in-process fetch adapter: no port,
  no second process, no second execution model.
- **The SDK is an HTTP client** — `better-trigger` ships `task()` and
  `betterTrigger({ url })`, has zero runtime dependencies and never opens a
  database connection, so it is safe to import into a web server or a CLI.
  Edge / browser imports work too: `node:async_hooks` (used only to detect
  "am I inside a running task?") is loaded lazily, so triggering from an edge
  function or a browser bundle is fine — task-ctx detection just reads
  undefined there (p1-16).
- **Replay, not snapshots** — completed steps are memoized in Postgres; after a
  crash or a long `wait`, the task function re-runs and cached steps return
  instantly. Persistent leases plus a monotonic **fencing token** per claim
  reject late writes from a dead worker, so step history stays exactly-once.
- **Batteries in the runtime** — retries with backoff, idempotency keys, cron
  and concurrency limits; the daemon host additionally serves the dashboard,
  `/health` and Prometheus `/metrics` on its HTTP port.

## Quick start

One command. `docker compose up` starts Postgres **and** a daemon already
running the example tasks in [`examples/basic`](./examples/basic) — including a
cron task that fires every two seconds, so there is something executing from the
first command. The example is baked into the worker image, so nothing needs to
be installed or built on your machine first:

```bash
docker compose up -d   # postgres:16 + the daemon on 127.0.0.1:4848

curl localhost:4848/api/v1/tasks   # the example tasks, registered
curl localhost:4848/api/v1/runs    # …and the cron runs they are already producing
curl -X POST localhost:4848/api/v1/trigger \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'
```

The [dashboard](#dashboard) points at `http://localhost:4848` and shows all of
it. To run your own tasks in the container instead, mount your module and point
`--tasks` at it — the commented `volumes` / `command` pair on the `worker`
service in [`docker-compose.yml`](./docker-compose.yml) shows the shape.

Or keep the daemon on your machine:

```bash
bun install && bun run build
createdb better_trigger      # or: docker compose up -d postgres
```

```ts
// tasks.ts — imported by the daemon, and by your app for type-safe triggers
import { task } from "better-trigger";

export const hello = task({
  id: "hello-world",
  run: async (payload: { name: string }) => `hello, ${payload.name}`,
});
```

Start the daemon — it loads `tasks.ts`, applies migrations, executes runs and
serves the API on `:4848`:

```bash
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

Then trigger from anywhere:

```ts
// app.ts — no database, no execution loop
import { betterTrigger } from "better-trigger";
import { hello } from "./tasks";

betterTrigger({ url: "http://localhost:4848" }).setDefault();

const handle = await hello.trigger({ name: "ada" });
const result = await handle.result();   // { status: "completed", output: "hello, ada" }
console.log(result.output);             // "hello, ada" — typed as the task's return value
```

`handle.result()` waits for a terminal state. A run that takes longer than the
wait budget (30s by default) returns its **latest non-terminal status** instead
of the output — always check `result.status` if the run may run long, or pass
`{ throwOnTimeout: true }` to make the timeout throw `ResultTimeoutError`
(with the latest status) instead.

The daemon runs your TypeScript task modules directly under `bun`. Under plain
`node`, point `--tasks` at compiled JavaScript (or use a loader such as `tsx`).

### Embedded mode (no separate daemon)

For a long-lived Node/Bun application, install the worker package as a runtime
dependency and start it during application boot:

```ts
import { createEmbeddedRuntime } from "@better-trigger/worker/embedded";
import { hello } from "./tasks";

const runtime = await createEmbeddedRuntime({
  databaseUrl: process.env.DATABASE_URL,
  tasks: [hello],
  concurrency: 5,
});

// createEmbeddedRuntime makes runtime.client the default, so TaskHandle APIs
// keep the same shape as daemon mode.
const handle = await hello.trigger({ name: "ada" });
console.log((await handle.result()).output);

// Wire this into the host framework's graceful-shutdown hook.
await runtime.stop();
```

The runtime applies migrations by default, owns its pool when given a
`databaseUrl`, starts claim/heartbeat/timer/cron/reaper loops, and drains plus
releases claims on `stop()`. Pass an existing `pool` to share the application's
pool; injected pools are not closed unless `closePoolOnStop: true` is set. The
runtime never sets `search_path` on the pool it uses, so the host's unqualified
queries keep resolving exactly as before.

Pass `databaseUrl` or `pool` explicitly. Embedded mode does not read the host's
environment implicitly; `env` optionally accepts validated daemon-style
configuration (for example `{ NODE_ENV: "production" }`). A `namespaces` option
controls which work the worker serves; triggers still use `default/prod` unless
their options include the matching `{ projectId, env }` pair.

### Sharing a Postgres database

better-trigger creates and touches only the fixed PostgreSQL schema
`better_trigger`. The schema name is independent of the database name, so
`DATABASE_URL` can point at your application's database. The nine business
tables, their indexes and sequences, and this project's own migration journal
(`better_trigger.__drizzle_migrations`) all live there. The host's `public`
tables and its own Drizzle journal (`drizzle.__drizzle_migrations`) are never
read or written, even when the same table names exist.

The runtime does not set `search_path`: every better-trigger query names
`better_trigger.<table>`, so the host's unqualified queries keep resolving
through its own `search_path` — including on a pool shared with embedded mode.

Migrations run automatically at startup and need a role that may `CREATE
SCHEMA` and create tables/indexes/sequences in it. To migrate with one role and
run with a less privileged one, apply migrations first and start with
`--no-migrate` (daemon) or `migrate: false` (embedded); the running role then
needs `USAGE` on `better_trigger` plus privileges on its tables and sequences.

This is a **fresh-install contract**: a database installed by a pre-schema
version (tables in `public`, default journal) is not upgraded in place. The
schema name is deliberately fixed — no runtime option changes it — and the
schema separates names, not permissions or resources: access is still governed
by the database roles you grant.

### Pinned Git source dependency (Bun)

The repository also exposes TypeScript source without a package build or install
hooks. Pin a full reviewed commit SHA, using the same single Git dependency for
task definitions and the embedded worker:

```json
{
  "dependencies": {
    "@better-trigger/source": "github:zhy0216/better-trigger#<full-commit-sha>"
  }
}
```

```ts
import { task } from "@better-trigger/source/sdk";
import { createEmbeddedRuntime } from "@better-trigger/source/worker/embedded";

const hello = task("hello", async (payload: { name: string }, ctx) =>
  ctx.step("greet", () => `Hello ${payload.name}`),
);
const runtime = await createEmbeddedRuntime({
  databaseUrl: applicationConfig.databaseUrl,
  tasks: [hello],
});
try {
  console.log(await (await hello.trigger({ name: "Ada" })).result());
} finally {
  await runtime.stop();
}
```

Run `bun install --ignore-scripts`; no sibling checkout, workspace link,
consumer `tsconfig.paths`, or generated `dist` is required. Both entries use
the same SDK registry. SQL migrations resolve relative to the installed source
and install into the same fixed `better_trigger` schema as every other entry,
with their own `better_trigger.__drizzle_migrations` journal — so the Git
dependency can share a database with the application and leaves the host's
`public` objects and `drizzle.__drizzle_migrations` untouched. The first
install needs a database role allowed to run that DDL (or migrations applied
separately); this entry does not expose the worker HTTP app automatically.

`bun run verify:git-install` tests a fresh install of committed HEAD with
lifecycle scripts disabled and a strict Bun/TypeScript consumer. Pass
`--github` after pushing to verify GitHub's actual pinned-SHA path. Set
`BT_GIT_TEST_ADMIN_URL` to a PostgreSQL URL whose role can create databases to
also test embedded execution; the check creates and drops its own random test
database and leaves existing application databases untouched.

Embedded mode removes the extra OS process, not the need for an online worker:
when the application is stopped, durable state remains in Postgres but tasks,
timers and cron do not execute. It is intended for long-lived Node/Bun hosts,
not scale-to-zero request functions. Task execution also shares the host's CPU,
memory and failure domain; use the daemon when isolation or independent scaling
matters.

### Dashboard

The daemon serves the built dashboard itself: `docker compose up` and open
<http://127.0.0.1:4848> — same origin as the API, on one port. A
deep link (e.g. a `/runs/...` URL you bookmarked) refreshes to the dashboard
instead of a 404, and hashed assets are served `immutable` so a daemon restart
always hands out the new bundle.

For dashboard development, run Vite standalone — it proxies nothing, so point
it at the daemon:

```bash
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev   # :5173
```

Without `VITE_BT_API_URL` the dev server targets `http://localhost:4848`.
A production build talks to the origin it was loaded from. Remote HTTPS
dashboards are allowed when their origin matches the request URL the worker
receives. If a TLS proxy rewrites that URL to an internal HTTP address,
configure the public origin with `--cors-origin` or
`BETTER_TRIGGER_CORS_ORIGIN` (see [CORS](./apps/worker/README.md#cors)).

If the daemon uses `BETTER_TRIGGER_API_KEY`, the dashboard prompts for a key
after a `401` and remembers a manually entered token in browser storage across
refreshes. Use **Forget API key** to remove it. If storage is unavailable, the
token lasts only for the current page. For
local development only, `VITE_BT_API_KEY=...` may supply the initial token, but
Vite embeds all `VITE_*` values in the bundle. Never use that option with a
long-lived bearer secret in a public deployment.

## Writing tasks

```ts
import { task } from "better-trigger";

export const onboarding = task({
  id: "user-onboarding",
  retry: { maxAttempts: 5 },
  run: async (payload: { userId: string }, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: user.id });
    await ctx.wait.for("24h");          // suspends; frees the slot; replays on resume
    await ctx.step("send-tips", () => sendTips(user));
  },
});

await onboarding.trigger({ userId: "u1" }, { idempotencyKey: "u1" });
```

Task modules are imported by the daemon, so daemon-hosted tasks must be
importable on their own. Embedded tasks are passed as handles and may use
application-level dependencies, but durable runs still must not capture
request-scoped or ephemeral state that cannot be reconstructed after restart.

See [`packages/sdk/README.md`](./packages/sdk/README.md) for the full SDK API
(cron, `triggerAndWait`, `batchTrigger`, `ctx.now/random/uuid`, AbortError).

## Running the daemon

`--tasks` and `--no-serve` are independent, so the same binary covers every
shape:

```bash
better-trigger-worker --tasks ./tasks.ts                  # all-in-one (default)
better-trigger-worker                                     # API + dashboard only
better-trigger-worker --tasks ./tasks.ts --no-serve       # executor-only node
better-trigger-worker --help                              # every flag and env var
```

SIGINT/SIGTERM shut down gracefully: stop claiming, drain in-flight runs, stop
the loops, close the server, end the pool. A clean restart hands claims back
without spending a retry attempt.

**Network posture.** The API binds `127.0.0.1` and is unauthenticated — so
"local" has to mean local. Set `BETTER_TRIGGER_API_KEY` and the API requires
`Authorization: Bearer <key>`; the SDK takes the same value. A non-loopback
`--host` **without** a key refuses to start unless `--allow-unauthenticated`
says the exposure is deliberate. Browser origins may match the worker's
request URL (including remote HTTPS) or use HTTP/HTTPS loopback origins;
`--cors-origin` / `BETTER_TRIGGER_CORS_ORIGIN` adds explicit origins.

CORS controls whether a browser can read a response. A separate origin check
rejects disallowed origins on unsafe API methods with `403 origin_not_allowed`
before any side effect, including bodyless cancel/retry POSTs and form requests.
SDK, curl and embedded callers that send no `Origin` remain supported;
authentication and rate limits still apply.

For deployments that are explicitly on the network, the daemon also ships the
security edge that makes that survivable (see the
[worker README](./apps/worker/README.md#network-exposure) for the full
detail):

- **Multiple keys + rotation** — `BETTER_TRIGGER_API_KEYS` adds keys alongside
  the primary, each optionally carrying a `key@2030-01-01` expiry suffix
  (past it: `401 key_expired`). Rotation is coexistence: add the new key, let
  old requests drain, remove the old one.
- **Rate limiting** — `trigger` / `batch-trigger` / `retry` / `cancel` are
  token-bucket limited per key and per endpoint (defaults 50/s and 200/s,
  knobs `BETTER_TRIGGER_RATE_LIMIT_RPS` / `_GLOBAL_RPS` / `_BURST`: `0` on a
  rate knob disables that bucket, `0` on `_BURST` disables the limiter
  entirely), answered `429 rate_limited` — a hostile or misconfigured client
  cannot create runs without bound. In-memory per process: for an exact
  fleet-wide cap, rate-limit at the reverse proxy.
- **Audit log** — one JSON line per API request to stdout (`requestId`, key
  fingerprint, caller, task/run ids, status, rejection reason); payloads and
  Authorization headers are never recorded, and the `requestId` doubles as the
  production-500 correlation id and the `x-request-id` response header.
- **TLS / proxy / DB** — terminate TLS at a reverse proxy in front of the
  daemon, never trust `X-Forwarded-For` for enforcement, and keep Postgres
  reachable only by the daemon; the SDK never opens a database connection.

**Limits** (all overridable by env): request body 1 MiB
(`BETTER_TRIGGER_BODY_LIMIT`, over it `413`), 500 items per `batchTrigger`
(`BETTER_TRIGGER_MAX_BATCH`), 1 MiB of serialized payload across one
`batchTrigger` (`BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES`), 256 KiB serialized
payload per run (`BETTER_TRIGGER_MAX_PAYLOAD_BYTES`), plus per-value caps for
step output, run output, error records and log data (`BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES`,
`_RUN_OUTPUT_`, `_ERROR_`, `_LOG_DATA_`, `_LOG_BATCH_` — see the
[worker README](./apps/worker/README.md#request-limits)). A value JSON cannot
represent (circular structure, BigInt) is refused with `400 serialization_error`
naming the field — never a raw `TypeError` that would read as a 500.

**Observability.** `GET /api/v1/health` is always open (no key needed) and
answers `{ ok, version, sha? }` — `version` is the package version baked into
the build (the same value the published tarball carries) and `sha` the git
commit it was built from, so the running artifact is traceable to a release
and a commit; `?deep=1` adds a database probe and pool stats and returns
`503` when the database is down. `GET /api/v1/metrics` renders
Prometheus text — queue depth, in-flight runs, run outcomes, claim/heartbeat
error counters, reaper recoveries, orchestrator loop errors, plus a
`better_trigger_build_info{version,sha}` gauge — and stays `200` with
`db_up 0` when Postgres is unreachable.

**Retention** is off by default: the daemon deletes no history unless asked.
`--retention 30d` turns on an hourly GC that removes terminal runs (steps and
logs cascade) and offline worker rows past the window. One-shot instead:

```bash
better-trigger-worker prune --older-than 30d --dry-run   # report, delete nothing
better-trigger-worker prune --older-than 30d
```

Queued / running / waiting runs are never deleted at any age, and neither are
tasks or schedules.

## Layout (Turborepo + bun workspaces)

```
.
├── apps/
│   ├── worker/          # @better-trigger/worker — THE daemon: task loader, replay
│   │                    #   executor, orchestrator loops, Hono API (bin: better-trigger-worker)
│   └── web/             # dashboard (Vite + React)
├── packages/
│   ├── core/            # @better-trigger/core — shared types/errors/utils, ZERO deps
│   ├── kernel/          # @better-trigger/kernel — durable engine over Postgres:
│   │                    #   claim + lease/fencing, retry/backoff, suspend/resume, cron
│   ├── db/              # @better-trigger/db — Drizzle schema + generated migrations + pool
│   ├── sdk/             # better-trigger — task() + betterTrigger() HTTP client (no pg)
│   └── testing/         # @better-trigger/testing — private harness: scenario runner,
│                        #   per-scenario databases, daemon control, invariant assertions
├── examples/
│   └── basic/           # example tasks + the acceptance scenarios
├── docs/
│   ├── architecture.md        # architecture & roadmap (the source of truth)
│   └── backend-contract.md    # engine semantics (§3 normative)
└── docker-compose.yml   # postgres + the worker daemon, running examples/basic
```

Only `apps/worker`, `packages/kernel` and the private test harness import `pg`.
That boundary is the whole point of the layout: `better-trigger`, the package
your application installs, cannot reach the database even by accident —
`check:deps` fails CI if `core` or the SDK ever grows a runtime dependency.

## Development

```bash
bun run dev            # turbo run dev
bun run build          # build all packages (tsdown) + web (tsc + vite)
bun run typecheck      # tsc --noEmit everywhere
bun run lint           # ESLint (shared baseline in eslint.config.mjs) on JS and
                       # TS/TSX in every workspace plus the root scripts and
                       # configs (//#lint:root); tsc still does the type checking
bun run test           # vitest unit tests. DB-free by default; the kernel's
                       # true-Postgres suite (packages/kernel/test/pg) runs
                       # automatically when DATABASE_URL is set, skips cleanly
                       # when it isn't.
bun run test:acceptance   # every acceptance harness — REQUIRES a live Postgres

bun run check:deps     # core stays zero-dep; the SDK depends on core and nothing else
bun run check:drift    # packages/db schema.ts vs. the generated migrations (offline)
bun run check:exports  # publint + attw on the published core/sdk/worker artifacts
```

`test:acceptance` runs every harness in `examples/basic/scripts/acceptance.ts`
(e2e, embedded, schema-isolation, fencing, replay-drift, code-version-pinning,
rolling-deploy, migration, concurrency, crash, worker-lost, graceful-restart,
retention, stats, run-detail, notify, batch-perf, constraints, health-pool,
loop-hang). Each provisions its own database and starts the hosts it needs; the
embedded scenario uses no daemon or TCP port. Pass names to run a subset:
`bun scripts/acceptance.ts embedded fencing crash`.
Everything above runs on every PR — see
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Status / roadmap

Implemented: task/step replay · queue/retry/idempotency · wait.for/until ·
triggerAndWait/batchTrigger · cron · concurrency limits · lease/fencing
crash-safety · retention/prune · health + metrics · dashboard.

Roadmap: see [`docs/architecture.md`](./docs/architecture.md) **P2–P6** —
correctness hardening (step fingerprints, LISTEN/NOTIFY), events
(`wait.forEvent`), CLI, agent-layer primitives
(`handoff`/`gather`/`requestApproval`/`ctx.llm`), plugins.
[`docs/backend-contract.md`](./docs/backend-contract.md) §3 is the normative
engine contract (replay invariants, queue, suspend/resume, retries).

## License

MIT — see [`LICENSE`](./LICENSE).
