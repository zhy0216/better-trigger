# better-trigger

A TypeScript-first, **embedded**, PostgreSQL-backed durable execution runtime
— like Better Auth, `betterTrigger(options)` gives you a full instance inside
your own process: **no orchestration server, no Redis, no ClickHouse** —
`pg` is the only hard dependency.

- **Embedded runtime** — client, in-process worker, and orchestrator loops
  (timers / cron / lease reaper) all live in your app process. Run N processes
  against the same Postgres and they coordinate via `FOR UPDATE SKIP LOCKED`
  — no leader election.
- **TS SDK** (`better-trigger`) — `task()` / `ctx.step()` / `ctx.wait` /
  `trigger()` with full type inference; one package to install.
- **Replay model** — no container snapshots: completed steps are memoized in
  Postgres; after a crash or a long `wait`, the task function re-runs and
  cached steps return instantly. `kill -9` a process mid-run and another one
  picks up where it left off.
- **Crash-safe by construction** — persistent leases (`lease_until`) plus a
  monotonic **fencing token** per claim; late writes from a dead worker are
  rejected, so step history stays exactly-once.
- **Postgres-only queue** — exponential-backoff retries, idempotency keys,
  cron schedules, concurrency limits.
- **Dashboard (optional)** — live runs, trace-style run detail with logs,
  schedules, workers. A separate tool process, not part of the architecture.

## Quick start

```bash
bun install && bun run build

# Postgres (any of: local install, or `docker compose up -d` for postgres:16)
createdb better_trigger
```

```ts
// trigger.ts — the single configuration point
import { betterTrigger } from "better-trigger";

export const trigger = betterTrigger({
  database: { connectionString: process.env.DATABASE_URL },
  migrations: "auto",              // migrate the system schema on first use
});

// tasks.ts
import { task } from "better-trigger";

export const hello = task({
  id: "hello-world",
  run: async (payload: { name: string }) => `hello, ${payload.name}`,
});

// main.ts — your app process is the worker
import { trigger } from "./trigger";
import { hello } from "./tasks";

await trigger.start({ tasks: [hello], concurrency: 5 });

const handle = await hello.trigger({ name: "ada" });
console.log(await handle.result());   // { status: "completed", output: "hello, ada" }
```

No HTTP anywhere: triggering, claiming, and reporting all go straight to
Postgres. A dedicated worker is just another process running the same
configuration against the same database.

### Optional dashboard

```bash
# dashboard API (read/trigger/cancel/retry over the same Postgres; no orchestration)
cd packages/server && DATABASE_URL=postgres://localhost:5432/better_trigger bun src/main.ts

# web UI on :5173 (Live mode)
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev
```

## Layout (Turborepo + bun workspaces)

```
.
├── apps/
│   └── web/             # dashboard (Vite + React) — live API + mock fallback
├── packages/
│   ├── core/            # @better-trigger/core — durable kernel: claim + lease/fencing,
│   │                    #   retry/backoff, suspend/resume, cron, orchestrator loops
│   ├── db/              # @better-trigger/db — Drizzle schema + generated migrations + pool factory
│   ├── sdk/             # better-trigger — betterTrigger() facade + task()/ctx +
│   │                    #   replay executor + in-process worker
│   └── server/          # @better-trigger/server — optional dashboard API (Hono, REST for apps/web)
├── examples/
│   └── basic/           # example tasks + embedded worker + e2e/crash/fencing scripts
├── docs/
│   ├── architecture.md        # v2 architecture & roadmap (the source of truth)
│   └── backend-contract.md    # engine semantics (§3 still normative; HTTP transport superseded)
└── docker-compose.yml   # postgres (and optionally the dashboard API, --profile server)
```

## Writing tasks

```ts
import { task } from "better-trigger";

export const onboarding = task({
  id: "user-onboarding",
  retry: { maxAttempts: 5 },
  run: async (payload: { userId: string }, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: user.id });
    await ctx.wait.for("24h");          // suspends; frees the worker; replays on resume
    await ctx.step("send-tips", () => sendTips(user));
  },
});

await onboarding.trigger({ userId: "u1" }, { idempotencyKey: "u1" });
```

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

**v2 embedded runtime (P1) has landed**: the durable kernel is embedded in the
SDK (direct Postgres claim with persistent leases + fencing tokens); the HTTP
worker protocol is removed, and `packages/server` is now a dashboard-only API.

Implemented: task/step replay · queue/retry/idempotency · wait.for/until ·
triggerAndWait/batchTrigger · cron · concurrency limits · lease/fencing
crash-safety · dashboard.

Roadmap: see [`docs/architecture.md`](./docs/architecture.md) **P2–P6** —
correctness hardening (step fingerprints, LISTEN/NOTIFY), events
(`wait.forEvent`), studio CLI, agent-layer primitives
(`handoff`/`gather`/`requestApproval`/`ctx.llm`), plugins.
