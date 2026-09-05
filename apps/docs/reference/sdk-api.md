# SDK API

The SDK is the package your application installs: **`better-trigger`**. It
defines tasks and triggers them through the worker HTTP surface. It has zero
runtime dependencies and never opens a database connection.

```bash
npm install better-trigger              # your app
npm install -D @better-trigger/worker   # the daemon (wherever you run it)
```

## Exports

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

`better-trigger/internal` is the seam the daemon uses to reach the executor
storage — **not** a public API and not covered by semver.

## `task()`

Two signatures:

```ts
export const hello = task("hello", async (payload: { name: string }) => `hi ${payload.name}`);

export const onboarding = task({
  id: "user-onboarding",
  schema: z.object({ userId: z.string() }),   // optional validator (Standard Schema / zod-style)
  retry: { maxAttempts: 5 },
  replay: "lenient" | "strict",               // default 'lenient'
  concurrency: { limit: 10, key: (p) => p.userId },
  cron: "0 9 * * *",                          // or { pattern, timezone }
  run: async (payload, ctx) => { /* … */ },
});
```

Returns a `TaskHandle<TPayload, TOutput>`; payload and output types flow
end-to-end. `schema` is duck-typed (no hard dependency on zod); a validation
failure fails the run immediately without retries.

## `betterTrigger(options)`

```ts
const trigger = betterTrigger({
  url: "http://localhost:4848",   // default: BETTER_TRIGGER_URL, then localhost:4848
  apiKey: process.env.MY_KEY,     // default: BETTER_TRIGGER_API_KEY
  timeoutMs: 30_000,              // per-request timeout
  fetch: myFetch,                 // injectable fetch (tests, proxies)
});
```

`timeoutMs` limits one HTTP request (default 30,000ms). It must be finite
and satisfy `0 < timeoutMs <= 2147483647` (about 24.8 days), including any
per-request override. Invalid values fail before fetch, timers, or abort
listeners are created. Positive fractions within this range remain valid
and are passed unchanged to the runtime timer.

This limit does not cap the total `waitForResult` / `result()` wait budget:
`{ timeoutMs: Infinity }` still waits indefinitely through successive
long-polls, each with a finite request timeout. Durable waits such as
`ctx.wait.for("30d")` and `ctx.wait.until(date)` persist a wake-up date;
they may exceed 24.8 days and are not subject to the HTTP timer limit.

The **first** `betterTrigger()` call becomes the module-level default;
`instance.setDefault()` takes over later. Runs in any JS environment — edge
functions and browsers included (`node:async_hooks` loads lazily).

### Instance API

| Member | Description |
|---|---|
| `trigger(taskOrId, payload, opts?)` | Enqueue one run → `RunHandle` |
| `batchTrigger(items, opts?)` | Enqueue many runs in one all-or-nothing transaction → `RunHandle[]` |
| `cancelRun(runId)` | Cancel a non-terminal run |
| `retryRun(runId)` | Re-run a failed/canceled run as a **new** run → `{ runId }` |
| `getRun(runId)` | Full run record |
| `getRunDetail(runId, opts?)` | `{ run, steps, waits, logs, … }` one snapshot; newest 200 logs, `opts.logsBefore` pages older |
| `waitForResult(runId, namespace?, opts?)` | Wait for terminal state → `{ status, output?, error? }` |
| `health()` | Daemon liveness → `{ ok, version }` |
| `setDefault()` | Make this instance the module-level default |
| `url` | The base URL this instance talks to |

### RunHandle

```ts
const run = await sendEmail.trigger({ to: "a@b.com" });
//   ^ { id: "run_...", idempotent, result(opts?) }

const settled = await run.result();
//   ^ { status: "completed", output: { delivered: true } }
```

`result()` waits for a terminal state; on timeout (default 30s) it returns the
latest non-terminal status. Pass `{ throwOnTimeout: true }` to throw
`ResultTimeoutError`, or `signal: AbortSignal` to cancel the long-poll.

## The run context (`ctx`)

| Member | Description |
|---|---|
| `ctx.step(label, fn, opts?)` | Durable, memoized step. Returns `fn`'s result. Throwing triggers retries. |
| `ctx.wait.for(duration)` | Suspend for a duration (`"24h"`, `"10m"`, or ms) |
| `ctx.wait.until(date)` | Suspend until an absolute `Date` |
| `ctx.logger.{debug,info,warn,error}` | Structured logging, flushed to Postgres |
| `ctx.now()` | Deterministic `Date` (memoized) |
| `ctx.random()` | Deterministic `[0,1)` number (memoized) |
| `ctx.uuid()` | Deterministic UUID v4 (memoized) |
| `ctx.run` | `{ id, taskId, attempt, maxAttempts, env }` |
| `ctx.signal` | `AbortSignal`, aborted on cancel / shutdown / lease loss |

## Trigger options

```ts
{
  delay?: string | number;   // "10m" or ms
  idempotencyKey?: string;   // same key → returns the existing run
  priority?: number;         // higher = claimed first
  concurrencyKey?: string;   // overrides concurrency.key()
  env?: string;              // default 'prod'
  projectId?: string;        // default 'default'
}
```

Inside a running task, `trigger` / `batchTrigger` are recorded as durable steps
automatically; children inherit the parent's namespace.

## Errors

| Error | Meaning |
|---|---|
| `KernelError` | Daemon answered with a kernel code (`task_not_found`, `run_not_running`, `stale_lease`, …); carries the same `code` on the wire |
| `HttpError` | Transport / auth / 5xx; has `status` and `code`; carries `requestId` on production 500s |
| `HttpError(0, 'timeout', …)` | The request hit its own per-request timeout — distinct from a connection failure |
| `AbortError` | Thrown by task code to fail a run without retry |
| `ResultTimeoutError` | `result({ throwOnTimeout: true })` hit the budget; carries the latest status |
| `RunAbortedError` | `ctx.signal.reason` — `'canceled' \| 'shutting_down' \| 'lease_lost'` (`isRunAborted(err)` recognizes it) |

After a `trigger()` timeout the run **may or may not have been created** — pass
an `idempotencyKey` to retry safely. Kernel codes are restored client-side to
`KernelError`, so `err.code` reads the same across the wire.

## Retry policy

`step options.retry ?? task retry ?? default`. The default is
`{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300000 }` with ±20% jitter.
`AbortError` and schema validation failures skip retries.

## Cron

```ts
export const daily = task({
  id: "daily-report",
  cron: "0 9 * * *", // or { pattern: "0 9 * * *", timezone: "Asia/Shanghai" }
  run: async () => { /* … */ },
});
```

Cron fires are computed from the database clock; missed windows are not
back-filled.
