# Writing tasks

A task is an object created with `task()` from the SDK. There are two
signatures:

```ts
import { task } from "better-trigger";

// Short form — id + run function
export const hello = task("hello", async (payload: { name: string }) =>
  `hi ${payload.name}`
);

// Config form — full options
export const onboarding = task({
  id: "user-onboarding",
  schema: z.object({ userId: z.string() }), // optional; validates + infers payload
  retry: { maxAttempts: 5 },
  replay: "strict",                        // optional; default 'lenient'
  concurrency: { limit: 10, key: (p) => p.userId },
  cron: "0 9 * * *",                       // or { pattern, timezone }
  run: async (payload, ctx) => {
    const user = await ctx.step("create-user", () => createUser(payload));
    ctx.logger.info("created", { id: user.id });
    await ctx.wait.for("24h");
    await ctx.step("send-tips", () => sendTips(user), { retry: { maxAttempts: 2 } });
    return user.id;
  },
});
```

`schema` accepts anything implementing the
[Standard Schema](https://standardschema.dev) `~standard` interface, or a
zod-style object exposing `parse` / `safeParse` — validation is fully
duck-typed, with **no hard dependency on zod**. A validation failure fails the
run immediately without retries.

The payload and return types are inferred end-to-end: the payload type comes
from the `run` parameter (or the `schema`), and the return type flows through
`triggerAndWait`.

::: warning Importable standalone
Task modules are imported by the daemon in its own process, so they must be
importable standalone — a `run` function may **not** close over your app's
request state or in-memory singletons. Embedded tasks are passed as handles and
may use application-level dependencies, but durable runs still must not capture
request-scoped or ephemeral state that cannot be reconstructed after restart.
:::

## The run context (`ctx`)

| Member | Description |
|---|---|
| `ctx.step(label, fn, opts?)` | Run a durable, memoized step. Returns `fn`'s result. Throwing triggers retries. |
| `ctx.wait.for(duration)` | Suspend for a duration (`"24h"`, `"10m"`, or ms). The worker slot is released. |
| `ctx.wait.until(date)` | Suspend until an absolute `Date`. |
| `ctx.logger.{debug,info,warn,error}` | Structured logging, buffered and flushed to Postgres. |
| `ctx.now()` | Deterministic `Date` — memoized for replay. |
| `ctx.random()` | Deterministic number in `[0, 1)` — memoized. |
| `ctx.uuid()` | Deterministic UUID v4 string — memoized. |
| `ctx.run` | `{ id, taskId, attempt, maxAttempts, env }` run metadata. |
| `ctx.signal` | `AbortSignal`, aborted when the run is canceled, the worker shuts down, or the lease is lost. |

### Determinism between steps

Code *between* steps re-runs on every replay, so it must be deterministic. Put
side effects, time, and randomness inside a `ctx.step`, or use `ctx.now()` /
`ctx.random()` / `ctx.uuid()` — all three are memoized mini-steps, so a replay
returns the same values the first run produced.

### The "never catch-all" rule

Suspending and ending an attempt are delivered **by throwing** internal signals.
Wrapping a durable primitive in a catch-all breaks the run: your code keeps
running after the run is already `waiting` or terminal, the side effects happen
again on replay, and they were never recorded.

```ts
try {
  await ctx.wait.for("1h");
} catch (err) {
  if (isControlFlowSignal(err)) throw err; // suspend AND end-of-execution
  // …your own handling
}
```

Use `isControlFlowSignal` (exported by the SDK), which recognizes both the
suspend signal and the end-of-execution signal. The runtime catches a missed
signal at the next durable primitive with an `AbortError` plus a `warn` line.

## Failure & retries

```ts
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
default`. The default is `{ maxAttempts: 3, baseMs: 1000, factor: 2, maxMs:
300000 }` with ±20% jitter. `AbortError` (and schema validation failures) skip
retries.

## Triggering

```ts
// One run
const run = await sendEmail.trigger({ to: "a@b.com" });
await sendEmail.trigger({ to: "a@b.com" }, { delay: "10m", idempotencyKey: user.id });

// Many runs — one all-or-nothing batch in a single namespace
const handles = await sendEmail.batchTrigger(
  [{ payload: { to: "a@b.com" } }, { payload: { to: "b@b.com" } }],
  { env: "staging" }
);

// Durable parent/child (inside a task only)
const result = await processVideo.triggerAndWait({ url });
if (result.ok) console.log(result.output);
```

### Trigger options

```ts
{
  delay?: string | number;   // "10m" or milliseconds
  idempotencyKey?: string;   // re-triggering with the same key returns the existing run
  priority?: number;         // higher-priority runs are claimed first
  concurrencyKey?: string;   // overrides the concurrency.key() result
  env?: string;              // environment scope (defaults to 'prod')
  projectId?: string;        // project scope (defaults to 'default'); pairs with env
}
```

`env`/`projectId` decide the run's namespace. `batchTrigger` takes them on the
**batch** call; per-item options are narrowed to exclude them. Inside a running
task, children always inherit the parent's namespace. When `trigger` /
`batchTrigger` are called **inside a running task**, they are recorded as
durable steps automatically — re-triggering on replay is idempotent.

### `triggerAndWait` never throws on child failure

`triggerAndWait` suspends the parent until the child finishes. It returns a
`TaskRunResult = { id, ok, output?, error? }` and never throws on child
failure — inspect the result, or unwrap it:

```ts
import { unwrapResult } from "better-trigger";

const result = await child.triggerAndWait(payload);
const output = unwrapResult(result); // throws if the child failed
```

## Cron tasks

```ts
export const dailyReport = task({
  id: "daily-report",
  cron: "0 9 * * *", // or { pattern: "0 9 * * *", timezone: "Asia/Shanghai" }
  run: async () => { /* … */ },
});
```

Cron fires are computed from the **database clock** (`now()`), so a skewed
daemon clock cannot make the same schedule fire twice. Missed windows (e.g. all
daemons down) are not back-filled — the next run is computed from the current
time. Registration upserts a `schedules` row that the dashboard shows and you
can enable/disable.
