# better-trigger

**Type-safe, self-hostable durable task orchestration for TypeScript.**

Declare background tasks as plain async functions, run durable steps, wait for
seconds or days, retry with backoff, schedule with cron — all on top of a single
server process and one Postgres database. No Redis, no ClickHouse, no Docker-in-Docker.

`better-trigger` uses a **replay** model instead of container snapshots: when a
run suspends on a wait, the worker is released; when the wait expires the task
function re-runs from the top, and already-completed steps return their cached
results instantly. The code reads like a straight-line `async` function.

---

## Install

```bash
npm install better-trigger
# or: bun add better-trigger / pnpm add better-trigger
```

Requires Node.js 18+. You also need a running [better-trigger server](#) and a
Postgres database (`docker compose up` in the self-host setup).

---

## Quick start

### 1. Define a task

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

### 2. Run a worker

```ts
// worker.ts
import { startWorker } from "better-trigger";
import { sendEmail } from "./tasks";

await startWorker({ tasks: [sendEmail], concurrency: 5 });
```

The worker registers its tasks, long-polls the server for work, replays each
run, and reports results. `SIGINT` / `SIGTERM` drain in-flight runs gracefully.

### 3. Trigger from your app

```ts
import { sendEmail } from "./tasks";

const run = await sendEmail.trigger({ to: "a@b.com" });
//    ^ { id: "run_..." }
```

---

## Configuration

The SDK and worker resolve their target server from, in order:

1. an explicit `configure({ apiUrl, apiKey })` call,
2. the `apiUrl` / `apiKey` passed to `startWorker`,
3. the `BETTER_TRIGGER_API_URL` / `BETTER_TRIGGER_API_KEY` environment variables,
4. the default `http://localhost:4848` (no key — local unauthenticated mode).

```ts
import { configure } from "better-trigger";

configure({
  apiUrl: "https://trigger.internal.acme.com",
  apiKey: process.env.MY_KEY,
});
```

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
| `ctx.wait.for(duration)` | Suspend for a duration (`"24h"`, `"10m"`, or ms). The worker is released. |
| `ctx.wait.until(date)` | Suspend until an absolute `Date`. |
| `ctx.logger.{debug,info,warn,error}` | Structured logging, buffered and shipped to the server. |
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
  priority?: number;         // higher dequeues first
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
default`. The default is `{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs: 300000 }`
with `±20%` jitter. `AbortError` (and schema validation failures) skip retries.

---

## Worker

```ts
await startWorker({
  tasks: [hello, onboarding, daily],
  concurrency: 5,         // concurrent execution slots
  name: "worker-1",       // optional, shown in the dashboard
  apiUrl: "...",          // optional overrides
  apiKey: "...",
});
```

The worker spins up `concurrency` long-poll loops, heartbeats every 15 s
(extending its run locks and honouring server-side cancellations), and exits
gracefully on `SIGINT` / `SIGTERM` after draining in-flight runs (up to 30 s).

The code version reported on registration comes from
`BETTER_TRIGGER_VERSION`, or a stable hash of the sorted task ids + cron config.

---

## API surface

```ts
import {
  task,
  configure,
  startWorker,
  unwrapResult,
  AbortError,
  SuspendSignal,
  ApiError,
  isApiError,
  isRunNotRunning,
} from "better-trigger";

import type {
  TaskHandle,
  RunCtx,
  TaskRunResult,
  TriggerOptions,
  RetryPolicy,
  StartWorkerOptions,
  WorkerHandle,
} from "better-trigger";
```

---

## License

MIT
