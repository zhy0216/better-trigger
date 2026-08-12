# better-trigger

**Type-safe durable task orchestration for TypeScript.**

Declare background tasks as plain async functions, run durable steps, wait for
seconds or days, retry with backoff, schedule with cron — on top of one Postgres
database. No Redis, no ClickHouse.

This package is the **client half**: it defines tasks and triggers them over
HTTP. It has zero runtime dependencies and never opens a database connection.
The **worker daemon** (`better-trigger-worker`, from `@better-trigger/worker`)
owns Postgres, imports your task modules and executes them.

`better-trigger` uses a **replay** model instead of container snapshots: when a
run suspends on a wait, the execution slot is released; when the wait expires
the task function re-runs from the top, and already-completed steps return their
cached results instantly. The code reads like a straight-line `async` function.

---

## Install

```bash
npm install better-trigger              # your app
npm install -D @better-trigger/worker   # the daemon (wherever you run it)
```

Requires Node.js 18+ (or Bun) and a reachable PostgreSQL database. That's the
whole stack.

---

## Quick start

### 1. Define a task

```ts
// tasks.ts — imported by the daemon AND by your app
import { task } from "better-trigger";

export const sendEmail = task("send-email", async (payload: { to: string }) => {
  await mailer.send(payload.to, "Welcome!");
  return { delivered: true };
});
```

The payload type is inferred from the function parameter, and the return type
flows through to `triggerAndWait`.

> Task modules are imported by the daemon in its own process, so they must be
> importable standalone — a `run` function may not close over your app's
> request state or in-memory singletons.

### 2. Run the daemon

```bash
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

It applies migrations, registers the tasks, claims runs straight from Postgres
(`FOR UPDATE SKIP LOCKED`), replays them, and serves the API on `:4848`.
`SIGINT` / `SIGTERM` drain in-flight runs gracefully. Under plain `node`, point
`--tasks` at compiled JavaScript (or use a loader such as `tsx`).

### 3. Point the client at it

```ts
// trigger.ts — the single configuration point in your app
import { betterTrigger } from "better-trigger";

export const trigger = betterTrigger({ url: "http://localhost:4848" });
```

### 4. Trigger

```ts
import { sendEmail } from "./tasks";

const run = await sendEmail.trigger({ to: "a@b.com" });
//    ^ { id: "run_...", idempotent, result(opts?) }

const settled = await run.result();
//    ^ { status: "completed", output: { delivered: true } }
```

---

## Configuration

```ts
import { betterTrigger } from "better-trigger";

const trigger = betterTrigger({
  url: "http://localhost:4848",   // default: BETTER_TRIGGER_URL, then localhost:4848
  apiKey: process.env.MY_KEY,     // default: BETTER_TRIGGER_API_KEY
  timeoutMs: 30_000,              // per-request timeout (long-polls manage their own)
  fetch: myFetch,                 // injectable fetch (tests, proxies, custom agents)
});
```

- `apiKey` is required when the daemon runs with `BETTER_TRIGGER_API_KEY` set;
  it is sent as `Authorization: Bearer <key>`.
- The **first** `betterTrigger()` call becomes the module-level default
  instance; `TaskHandle.trigger` / `batchTrigger` called outside a run use it
  (calling them with no instance created throws). A later instance can take
  over with `instance.setDefault()`.
- Retry defaults, concurrency and orchestrator intervals are daemon-side
  concerns — see `better-trigger-worker --help`.

### Instance API

| Member | Description |
| --- | --- |
| `trigger(taskOrId, payload, opts?)` | Enqueue one run. → `RunHandle` |
| `batchTrigger(items)` | Enqueue many runs in one transaction. → `RunHandle[]` |
| `cancelRun(runId)` | Cancel a non-terminal run (terminal → no-op). |
| `retryRun(runId)` | Re-run a failed/canceled run as a **new** run. → `{ runId }` |
| `getRun(runId)` | Full run record. |
| `getRunDetail(runId, opts?)` | `{ run, steps, stepsTruncated, waits, waitsTruncated, logs, logsNextCursor }` — one snapshot; newest 200 logs by default, `opts.logsBefore` pages older logs. |
| `waitForResult(runId, opts?)` | Wait for a terminal state. → `{ status, output?, error? }` Transient 5xx / network errors are retried automatically within the timeout budget (jittered backoff); if the budget runs out the last error is thrown. 4xx and kernel errors fail immediately. |
| `health()` | Daemon liveness probe. → `{ ok, version }` |
| `setDefault()` | Make this instance the module-level default. |
| `url` | The base URL this instance talks to. |

Failures the daemon reports with a kernel error code (`task_not_found`,
`run_not_running`, `stale_lease`, …) arrive as `KernelError` with that same
`code`. Transport failures, auth failures and 5xx arrive as `HttpError` with
`status` and `code`. A daemon running with `NODE_ENV=production` answers a 500
with a generic message and a correlation id instead of the internal error text;
that id shows up as `HttpError.requestId` (and inside `err.message`) — grep the
daemon's log for it to get the real error.

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
| `ctx.signal` | `AbortSignal`, aborted when the run is canceled, the worker shuts down, or the lease is lost. |

> **Cancellation:** pass `ctx.signal` to anything that accepts one
> (`fetch(url, { signal: ctx.signal })`, an LLM SDK, a child process) so a long
> call is cut off the moment its output stops mattering. `ctx.signal.reason` is a
> `RunAbortedError` whose `.reason` is `'canceled' | 'shutting_down' |
> 'lease_lost'` (`isRunAborted(err)` recognizes it). Ignoring the signal is safe
> — cancellation is still enforced at the next durable primitive — it just costs
> you the wait.

> **Never catch-all around a durable primitive.** Suspending (`ctx.wait`,
> `triggerAndWait`) and ending an attempt are delivered by throwing, so
> `try { await ctx.wait.for("1h") } catch {}` keeps your code running while the
> run is already `waiting`: the side effects after the catch really happen, are
> recorded nowhere, and happen again on replay. If a `catch` can see one, hand
> it back:
>
> ```ts
> try {
>   await ctx.wait.for("1h");
> } catch (err) {
>   if (isControlFlowSignal(err)) throw err; // suspend *and* end-of-execution
>   // ...your own handling
> }
> ```
>
> The runtime catches the mistake at the next durable primitive with an
> `AbortError` plus a `warn` line in the run's logs.

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

## The worker daemon

```bash
better-trigger-worker --tasks ./tasks.ts \
  --port 4848 --concurrency 5 --name worker-1 --lease-ms 60000
```

The daemon registers itself + its tasks, starts the orchestrator loops
(wait / cron / reaper timers), and spins up `--concurrency` claim loops (idle
polls back off 300ms → 2s with jitter). A heartbeat loop
(`max(500, leaseMs / 3)` ms) renews claimed leases and honours cancellations.
Every claim carries a **fencing token**; if a daemon dies, the reaper releases
the expired lease and any late writes from the zombie are rejected — steps stay
exactly-once.

`--tasks` and `--no-serve` are independent, so one binary covers every shape:

| Command | Role |
| --- | --- |
| `better-trigger-worker --tasks ./tasks.ts` | all-in-one: executes + serves (default) |
| `better-trigger-worker` | API + dashboard only; runs the reaper, executes nothing |
| `better-trigger-worker --tasks ./tasks.ts --no-serve` | executor-only node |

Run any number of daemons against the same database — they coordinate through
Postgres row locks; no leader election.

Each task reports a **code version** — `BETTER_TRIGGER_VERSION`, or a stable
hash of its id, cron config and `run()` body source — and every run it creates
is stamped with it (`runs.codeVersion`). Because replay keys steps by position,
that stamp is what tells you which code shape wrote a run's ledger after a
redeploy. `better-trigger-worker --pin-code-version` makes the claim honour it:
a run whose task was edited mid-flight waits for a worker that can still replay
it rather than being taken over by the new build. See the
[worker README](../../apps/worker/README.md#code-versions-and-redeploys) for
the trade-off (runs can wait indefinitely) and the metric that surfaces it.

---

## API surface

```ts
import {
  task,
  betterTrigger,
  unwrapResult,
  AbortError,
  HttpError,
  KernelError,
  SuspendSignal,
  isAbortError,
  isSuspendSignal,
  isControlFlowSignal,
} from "better-trigger";

import type {
  BetterTrigger,
  BetterTriggerOptions,
  RunHandle,
  TaskHandle,
  RunCtx,
  RunRecord,
  RunDetailResult,
  TaskRunResult,
  TriggerOptions,
  RetryPolicy,
  WaitResult,
} from "better-trigger";
```

`better-trigger/internal` also exists. It is the seam the worker daemon uses to
reach the executor storage and the normalized task definitions — **not** a
public API, and not covered by semver.

---

## License

MIT
