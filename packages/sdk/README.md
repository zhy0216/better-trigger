# better-trigger

**Type-safe, embedded durable task orchestration for TypeScript.**

Declare background tasks as plain async functions, run durable steps, wait for
seconds or days, retry with backoff, schedule with cron — all embedded in your
own process on top of one Postgres database. No orchestration server, no Redis,
no ClickHouse; `pg` is the only hard dependency.

`better-trigger` uses a **replay** model instead of container snapshots: when a
run suspends on a wait, the worker slot is released; when the wait expires the
task function re-runs from the top, and already-completed steps return their
cached results instantly. The code reads like a straight-line `async` function.

---

## Install

```bash
npm install better-trigger
# or: bun add better-trigger / pnpm add better-trigger
```

Requires Node.js 18+ (or Bun) and a reachable PostgreSQL database. That's the
whole stack.

---

## Quick start

### 1. Create the instance

```ts
// trigger.ts — the single configuration point
import { betterTrigger } from "better-trigger";

export const trigger = betterTrigger({
  database: { connectionString: process.env.DATABASE_URL },
});
```

### 2. Define a task

```ts
// tasks.ts
import { task } from "better-trigger";

export const sendEmail = task("send-email", async (payload: { to: string }) => {
  await mailer.send(payload.to, "Welcome!");
  return { delivered: true };
});
```

The payload type is inferred from the function parameter, and the return type
flows through to `triggerAndWait`.

### 3. Start a worker

```ts
// worker.ts — any process (your app itself, or a dedicated one)
import { trigger } from "./trigger";
import { sendEmail } from "./tasks";

await trigger.start({ tasks: [sendEmail], concurrency: 5 });
```

The worker registers its tasks, claims runs straight from Postgres
(`FOR UPDATE SKIP LOCKED`), replays each run, and reports results back over
the same pool. `SIGINT` / `SIGTERM` drain in-flight runs gracefully.

### 4. Trigger from your app

```ts
import { sendEmail } from "./tasks";

const run = await sendEmail.trigger({ to: "a@b.com" });
//    ^ { id: "run_...", result(opts?) }

const settled = await run.result();
//    ^ { status: "completed", output: { delivered: true } }
```

---

## Configuration

Everything is configured on the instance — there is no global config and no
HTTP endpoint to point at:

```ts
import { betterTrigger } from "better-trigger";

const trigger = betterTrigger({
  // pg Pool (caller-owned) or { connectionString } (instance-owned, ended on stop)
  database: { connectionString: process.env.DATABASE_URL },
  migrations: "auto",                  // 'auto' (default) | 'manual'
  defaults: { retry: { maxAttempts: 5 } },   // fallback retry for tasks without one
  orchestrator: { reaperIntervalMs: 10_000 }, // loop intervals (test knobs)
  plugins: [],                          // reserved (P1 accepts only [])
});
```

- `migrations: 'auto'` applies the packaged schema migrations on first use;
  `'manual'` assumes you ran them yourself (e.g. via `@better-trigger/db`).
- `defaults.retry` is inherited by tasks that do not define their own `retry`
  once a worker registers them: it sets both the trigger-time attempt budget
  (`max_attempts` on new runs) and the executor-side backoff between attempts.
- The **first** `betterTrigger()` call becomes the module-level default
  instance; `TaskHandle.trigger` / `batchTrigger` called outside a run use it
  (calling them with no instance created throws). A later instance can take
  over with `instance.setDefault()`.

### Instance API

| Member | Description |
| --- | --- |
| `start(opts)` | Start the embedded worker + orchestrator loops. → `WorkerHandle` |
| `stop()` | Stop the worker (if started) and end the pool when instance-owned. |
| `trigger(taskOrId, payload, opts?)` | Enqueue one run. → `RunHandle` |
| `batchTrigger(items)` | Enqueue many runs in one transaction. → `RunHandle[]` |
| `cancelRun(runId)` | Cancel a non-terminal run (terminal → no-op). |
| `retryRun(runId)` | Re-run a failed/canceled run as a **new** run. → `{ runId }` |
| `getRun(runId)` | Full run record. |
| `getRunDetail(runId)` | `{ run, steps, waits, logs }` (logs capped at 1000). |
| `waitForResult(runId, opts?)` | Poll to a terminal state. → `{ status, output?, error? }` |
| `setDefault()` | Make this instance the module-level default. |

---

## Tasks

### Config form

```ts
import { task } from "better-trigger";
import { z } from "zod"; // optional — any Standard Schema or zod-style schema works

export const onboarding = task({
  id: "user-onboarding",
  schema: z.object({ userId: z.string() }), // validates + infers payload type
  retry: { maxAttempts: 5 },
  concurrency: { limit: 10, key: (p) => p.userId },
  run: async (payload, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("user created", { id: user.id });

    await ctx.wait.for("24h");
    await ctx.wait.until(new Date("2030-01-01"));

    await ctx.step("send-tips", () => sendTips(user), { retry: { maxAttempts: 2 } });
    return user.id;
  },
});
```

`schema` accepts anything implementing the
[Standard Schema](https://standardschema.dev) `~standard` interface, or a
zod-style object exposing `parse` / `safeParse`. There is **no hard dependency
on zod** — validation is fully duck-typed. A validation failure fails the run
immediately without retries.

### Cron tasks

```ts
export const dailyReport = task({
  id: "daily-report",
  cron: "0 9 * * *", // or { pattern: "0 9 * * *", timezone: "Asia/Shanghai" }
  run: async () => { /* ... */ },
});
```

---

## The run context (`ctx`)

| Member | Description |
| --- | --- |
| `ctx.step(label, fn, opts?)` | Run a durable, memoized step. Returns `fn`'s result. Throwing triggers retries. |
| `ctx.wait.for(duration)` | Suspend for a duration (`"24h"`, `"10m"`, or ms). The worker slot is released. |
| `ctx.wait.until(date)` | Suspend until an absolute `Date`. |
| `ctx.logger.{debug,info,warn,error}` | Structured logging, buffered and flushed to Postgres. |
| `ctx.now()` | Deterministic `Date` — memoized for replay. |
| `ctx.random()` | Deterministic number in `[0, 1)` — memoized. |
| `ctx.uuid()` | Deterministic UUID v4 string — memoized. |
| `ctx.run` | `{ id, taskId, attempt, maxAttempts, env }` run metadata. |

> **Determinism:** code *between* steps re-runs on every replay, so it must be
> deterministic. Put side effects, time, and randomness inside `ctx.step` or use
> `ctx.now()` / `ctx.random()` / `ctx.uuid()`.

---

## Triggering

```ts
// One run
const run = await sendEmail.trigger({ to: "a@b.com" });
await sendEmail.trigger({ to: "a@b.com" }, { delay: "10m", idempotencyKey: user.id });

// Many runs
const handles = await sendEmail.batchTrigger([
  { payload: { to: "a@b.com" } },
  { payload: { to: "b@b.com" } },
]);

// Trigger a child and durably wait for it (inside a task only)
const result = await processVideo.triggerAndWait({ url });
if (result.ok) {
  console.log(result.output);
}
```

### Trigger options

```ts
{
  delay?: string | number;   // "10m" or milliseconds
  idempotencyKey?: string;   // re-triggering with the same key returns the existing run
  priority?: number;         // higher-priority runs are claimed first
  concurrencyKey?: string;   // overrides the concurrency.key() result
  env?: string;              // environment scope
}
```

When `trigger` / `batchTrigger` are called **inside a running task**, they are
recorded as durable steps automatically — re-triggering on replay is idempotent.

### `triggerAndWait`

`triggerAndWait` must be called inside a running task (it suspends the parent
until the child finishes). It **never throws** on child failure — inspect the
result:

```ts
import { unwrapResult } from "better-trigger";

const result = await child.triggerAndWait(payload);
// result: { id, ok, output?, error? }

const output = unwrapResult(result); // throws if the child failed
```

---

## Failure & retries

```ts
import { task, AbortError } from "better-trigger";

task({
  id: "charge",
  retry: { maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300_000 },
  run: async (payload, ctx) => {
    await ctx.step("charge", () => charge(payload)); // throwing → retried with backoff

    if (payload.amount <= 0) {
      throw new AbortError("invalid amount"); // fails immediately, no retry
    }

    await ctx.step("notify", () => notify(payload), { retry: { maxAttempts: 2 } });
  },
});
```

The effective retry policy for a step is `step options.retry ?? task retry ??
instance defaults.retry ?? default`. The default is
`{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300000 }` with `±20%`
jitter. `AbortError` (and schema validation failures) skip retries.

---

## Worker

```ts
const worker = await trigger.start({
  tasks: [hello, onboarding, daily],
  concurrency: 5,         // concurrent execution slots (default 5)
  name: "worker-1",       // optional, shown in the dashboard
  leaseMs: 60_000,        // lease granted per claim, renewed by heartbeat (default 60s)
});

worker.workerId;          // registered worker id
await worker.stop();      // drain in-flight runs, stop loops
```

`start()` registers the worker + tasks, starts the orchestrator loops
(wait/cron/reaper timers) in-process, and spins up `concurrency` claim loops
(idle polls back off 300ms → 2s with jitter). A heartbeat loop
(`max(500, leaseMs / 3)` ms) renews claimed leases and honours cancellations.
Every claim carries a **fencing token**; if a worker dies, the reaper releases
the expired lease and any late writes from the zombie are rejected — steps stay
exactly-once. `SIGINT` / `SIGTERM` drain in-flight runs, stop the loops, then
end the instance-owned pool.

Run any number of processes with the same tasks against the same database —
they coordinate through Postgres row locks; no leader election.

The code version reported on registration comes from
`BETTER_TRIGGER_VERSION`, or a stable hash of the sorted task ids + cron config.

---

## API surface

```ts
import {
  task,
  betterTrigger,
  unwrapResult,
  AbortError,
  SuspendSignal,
  isAbortError,
  isSuspendSignal,
} from "better-trigger";

import type {
  BetterTrigger,
  BetterTriggerOptions,
  RunHandle,
  TaskHandle,
  RunCtx,
  TaskRunResult,
  TriggerOptions,
  RetryPolicy,
  WorkerHandle,
} from "better-trigger";
```

---

## License

MIT
