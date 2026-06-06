# better-trigger

A **simpler, easier-to-self-host trigger.dev alternative**: durable task
execution with **one Node/Bun process + one Postgres** — no Redis, no
ClickHouse, no Docker-in-Docker.

- **TS SDK** (`better-trigger`) — `task()` / `ctx.step()` / `ctx.wait` /
  `trigger()` with full type inference; others install this one package.
- **Replay model** — no container snapshots: completed steps are memoized in
  Postgres; after a crash or a long `wait`, the task function re-runs and
  cached steps return instantly. Kill the worker mid-run and it picks up where
  it left off.
- **Postgres-only queue** — `FOR UPDATE SKIP LOCKED`, visibility timeouts,
  exponential-backoff retries, cron schedules, concurrency limits.
- **Dashboard** — live runs, trace-style run detail with logs, schedules,
  workers.

## Layout (Turborepo + bun workspaces)

```
.
├── apps/
│   └── web/             # dashboard (Vite + React) — live API + mock fallback
├── packages/
│   ├── core/            # @better-trigger/core — shared types/protocol/errors
│   ├── sdk/             # better-trigger — task()/ctx/replay executor/worker
│   └── server/          # @better-trigger/server — Hono API + queue + orchestrator
├── examples/
│   └── basic/           # example tasks + worker + e2e smoke script
├── docs/backend-contract.md   # the authoritative engine/API contract
└── docker-compose.yml   # postgres (and optionally the server, --profile server)
```

## Quick start

```bash
bun install && bun run build

# 1. Postgres (any of: local install, or `docker compose up` for postgres:16)
createdb better_trigger

# 2. server (API on :4848; runs migrations on boot)
cd packages/server && DATABASE_URL=postgres://localhost:5432/better_trigger bun src/main.ts

# 3. worker (registers example tasks, long-polls for runs)
cd examples/basic && bun src/worker.ts

# 4. trigger something
curl -X POST localhost:4848/api/v1/trigger \
  -H 'content-type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'

# 5. dashboard on :5173 (Live mode)
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev

# end-to-end smoke test (server + worker must be running)
cd examples/basic && bun scripts/e2e.ts
```

## Writing tasks

```ts
import { task, startWorker } from "better-trigger";

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
await startWorker({ tasks: [onboarding], concurrency: 5 });
```

See [`packages/sdk/README.md`](./packages/sdk/README.md) for the full SDK API
(cron, `triggerAndWait`, `batchTrigger`, `ctx.now/random/uuid`, AbortError),
[`packages/server/README.md`](./packages/server/README.md) for server/env/API,
and [`docs/backend-contract.md`](./docs/backend-contract.md) for engine
semantics (replay invariants, queue, suspend/resume, retries).

## Repo scripts

```bash
bun run dev          # turbo run dev
bun run build        # build all packages (tsup) + web (tsc + vite)
bun run typecheck    # tsc --noEmit everywhere
bun run lint
```

## Status / roadmap

Implemented (PRD M0–M2): task/step replay · queue/retry/idempotency ·
wait.for/until · triggerAndWait/batchTrigger · cron · concurrency limits ·
dashboard wiring. Next: events (`wait.forEvent`), CLI (`dev`/`migrate`),
multi-agent runtime primitives (see `multi-agent-design.md`).
