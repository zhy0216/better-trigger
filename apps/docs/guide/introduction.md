# Introduction

better-trigger is a **TypeScript-first, PostgreSQL-backed durable execution
runtime**. It lets you write long-running, failure-tolerant background work as
plain async functions — with retries, waits, cron schedules and fan-out — and
it stores *everything* it needs to survive crashes in one Postgres database.
**No Redis, no ClickHouse** — Postgres is the only infrastructure.

## The core idea

A durable task is an ordinary async function that you split into **steps**:

```ts
import { task } from "better-trigger";

export const onboarding = task({
  id: "user-onboarding",
  run: async (payload: { userId: string }, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: user.id });

    await ctx.wait.for("24h");          // suspends; the slot is released
    await ctx.step("send-tips", () => sendTips(user));
  },
});
```

Two properties make this durable:

- **Replay, not snapshots.** Completed steps are memoized in Postgres. After a
  crash, an OOM, or a long `wait`, the task function re-runs from the top, and
  every step that already completed returns its cached result instantly. Your
  code reads like a straight-line async function, but it is resumable.
- **Postgres as the engine.** The queue, the orchestrator loops (timers, cron,
  lease reaper) and the replay executor all live in the runtime and coordinate
  through Postgres row locks (`FOR UPDATE SKIP LOCKED`). Any number of worker
  processes can share one database — no leader election.

## How you run it

There are two deployment shapes, sharing the exact same runtime and semantics:

1. **Daemon (default).** `better-trigger-worker --tasks ./tasks.ts` runs the
   executor, the orchestrator loops and the HTTP API (plus a built-in
   dashboard) in one process.
2. **Embedded.** A long-lived Node/Bun application starts the same runtime
   in-process with `createEmbeddedRuntime({ tasks })` — no separate process,
   no open port.

The app that *triggers* tasks installs the SDK — an HTTP client with **zero
runtime dependencies** that never opens a database connection.

## What's included

| Capability | Notes |
|---|---|
| Durable steps | `ctx.step(label, fn)` — memoized, retried with backoff |
| Waits | `ctx.wait.for("24h")` / `ctx.wait.until(date)` — suspend & resume |
| Cron | `task({ cron: "0 9 * * *" })` — DB-clock based scheduling |
| Parent/child | `triggerAndWait` / `batchTrigger` — fan-out & fan-in |
| Retries | Exponential backoff with jitter, `AbortError` for no-retry failures |
| Idempotency | `idempotencyKey` on trigger |
| Concurrency limits | Per-task caps keyed by payload |
| Crash safety | Persistent leases + monotonic fencing tokens → exactly-once step history |
| Observability | `/health`, Prometheus `/metrics`, built-in dashboard |

## Where to go next

- **[Quick start](./quick-start)** — get something running in one command.
- **[Writing tasks](./writing-tasks)** — the `task()` API and `ctx` surface.
- **[Running the daemon](./running-the-daemon)** — every deployment shape.
- **[Embedded mode](./embedded-mode)** — the one-process host.
- **[Deployment & security](./deployment)** — auth, keys, limits, TLS.
