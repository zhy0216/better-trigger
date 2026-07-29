# better-trigger

A TypeScript-first, PostgreSQL-backed durable execution runtime. You run one
small **worker daemon** that owns the database and executes your tasks; your
application only ever speaks HTTP to it. **No Redis, no ClickHouse** — Postgres
is the only infrastructure.

- **One daemon owns Postgres** — the queue, the orchestrator loops (timers /
  cron / lease reaper) and the replay executor all live in
  `better-trigger-worker`. Run N daemons against the same database and they
  coordinate via `FOR UPDATE SKIP LOCKED` — no leader election.
- **The SDK is an HTTP client** — `better-trigger` ships `task()` for defining
  work and `betterTrigger({ url })` for triggering it. It has zero runtime
  dependencies and never opens a database connection, so it is safe to import
  into a web server, a CLI, or an edge-ish runtime.
- **Replay model** — no container snapshots: completed steps are memoized in
  Postgres; after a crash or a long `wait`, the task function re-runs and
  cached steps return instantly. `kill -9` a daemon mid-run and another one
  picks up where it left off.
- **Crash-safe by construction** — persistent leases (`lease_until`) plus a
  monotonic **fencing token** per claim; late writes from a dead worker are
  rejected, so step history stays exactly-once.
- **Postgres-only queue** — exponential-backoff retries, idempotency keys,
  cron schedules, concurrency limits.
- **Dashboard** — live runs, trace-style run detail with logs, schedules,
  workers; served by the same daemon.

## Quick start

```bash
bun install && bun run build

# Postgres (any of: local install, or `docker compose up -d` for postgres:16)
createdb better_trigger
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
  bunx --bun better-trigger-worker --tasks ./tasks.ts
```

Then trigger from anywhere:

```ts
// app.ts — no database, no execution loop
import { betterTrigger } from "better-trigger";
import { hello } from "./tasks";

betterTrigger({ url: "http://localhost:4848" }).setDefault();

const handle = await hello.trigger({ name: "ada" });
console.log(await handle.result());   // { status: "completed", output: "hello, ada" }
```

The daemon runs your TypeScript task modules directly under `bun`. Under plain
`node`, point `--tasks` at compiled JavaScript (or use a loader such as `tsx`).

### Dashboard

```bash
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev   # :5173
```

### Scaling out

`--tasks` and `--no-serve` are independent, so the same binary covers every
shape:

```bash
better-trigger-worker --tasks ./tasks.ts                  # all-in-one (default)
better-trigger-worker                                     # API + dashboard only
better-trigger-worker --tasks ./tasks.ts --no-serve       # executor-only node
```

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
│   └── sdk/             # better-trigger — task() + betterTrigger() HTTP client (no pg)
├── examples/
│   └── basic/           # example tasks + e2e/crash/fencing/worker-lost harnesses
├── docs/
│   ├── architecture.md        # architecture & roadmap (the source of truth)
│   └── backend-contract.md    # engine semantics (§3 normative)
└── docker-compose.yml   # postgres + the worker daemon
```

Only `apps/worker` and `packages/kernel` import `pg`. That boundary is the
whole point of the layout: `better-trigger`, the package your application
installs, cannot reach the database even by accident.

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
(cron, `triggerAndWait`, `batchTrigger`, `ctx.now/random/uuid`, AbortError),
[`docs/architecture.md`](./docs/architecture.md) for the architecture and
semantic guarantees, and [`docs/backend-contract.md`](./docs/backend-contract.md)
§3 for engine semantics (replay invariants, queue, suspend/resume, retries).

## Repo scripts

```bash
bun run dev          # turbo run dev
bun run build        # build all packages (tsup) + web (tsc + vite)
bun run typecheck    # tsc --noEmit everywhere
bun run lint
```

## Status / roadmap

The runtime is a **client/daemon split**: `better-trigger` defines and triggers
tasks over HTTP, `better-trigger-worker` owns Postgres and executes them.

Implemented: task/step replay · queue/retry/idempotency · wait.for/until ·
triggerAndWait/batchTrigger · cron · concurrency limits · lease/fencing
crash-safety · dashboard.

Roadmap: see [`docs/architecture.md`](./docs/architecture.md) **P2–P6** —
correctness hardening (step fingerprints, LISTEN/NOTIFY), events
(`wait.forEvent`), CLI, agent-layer primitives
(`handoff`/`gather`/`requestApproval`/`ctx.llm`), plugins.
