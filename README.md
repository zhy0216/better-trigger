# better-trigger

A TypeScript-first, PostgreSQL-backed durable execution runtime. You run one
small **worker daemon** that owns the database and executes your tasks; your
application only ever speaks HTTP to it. **No Redis, no ClickHouse** — Postgres
is the only infrastructure.

- **One daemon owns Postgres** — queue, orchestrator loops (timers / cron /
  lease reaper) and the replay executor all live in `better-trigger-worker`.
  Run N daemons against the same database and they coordinate via
  `FOR UPDATE SKIP LOCKED` — no leader election.
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
- **Batteries in the same process** — retries with backoff, idempotency keys,
  cron, concurrency limits, a live dashboard, `/health` and Prometheus
  `/metrics`.

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

### Dashboard

The daemon serves the built dashboard itself: `docker compose up` and open
<http://127.0.0.1:4848> — same origin as the API, no second port, no CORS. A
deep link (e.g. a `/runs/...` URL you bookmarked) refreshes to the dashboard
instead of a 404, and hashed assets are served `immutable` so a daemon restart
always hands out the new bundle.

For dashboard development, run Vite standalone — it proxies nothing, so point
it at the daemon:

```bash
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev   # :5173
```

(Without `VITE_BT_API_URL` the dev server targets `http://localhost:4848`
anyway; a production build — what the daemon serves — talks to the origin it
was loaded from, so it works from any host:port.)

If the daemon uses `BETTER_TRIGGER_API_KEY`, the dashboard prompts for a key
after a `401` and keeps a manually entered token only in page memory. Refreshing
the page clears it; it is never stored in browser storage or cookies. For
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

Task modules are imported by the daemon, so they must be importable on their
own — a task's `run` may not close over your application's request state.

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
says the exposure is deliberate. Browser origins are loopback-only by default;
add others with `--cors-origin`.

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
  knobs `BETTER_TRIGGER_RATE_LIMIT_RPS` / `_GLOBAL_RPS` / `_BURST`, `0`
  disables), answered `429 rate_limited` — a hostile or misconfigured client
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
bun run build          # build all packages (tsup) + web (tsc + vite)
bun run typecheck      # tsc --noEmit everywhere
bun run lint
bun run test           # vitest unit tests. DB-free by default; the kernel's
                       # true-Postgres suite (packages/kernel/test/pg) runs
                       # automatically when DATABASE_URL is set, skips cleanly
                       # when it isn't.
bun run test:acceptance   # every acceptance harness — REQUIRES a live Postgres

bun run check:deps     # core stays zero-dep; the SDK depends on core and nothing else
bun run check:drift    # packages/db schema.ts vs. the generated migrations (offline)
bun run check:exports  # publint + attw on the published core/sdk artifacts
```

`test:acceptance` runs every harness in `examples/basic/scripts/acceptance.ts`
(e2e, fencing, replay-drift, code-version-pinning, rolling-deploy, migration,
concurrency, crash, worker-lost, graceful-restart, retention, stats, run-detail,
notify, batch-perf, constraints, health-pool). Each provisions its own database
from `DATABASE_URL`, spawns its own daemons and exits non-zero on a failed
assertion. Pass names to run a subset: `bun scripts/acceptance.ts fencing crash`.
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
