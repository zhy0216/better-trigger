# @better-trigger/example-basic

SDK usage examples for [`better-trigger`](../../packages/sdk) plus the
end-to-end acceptance scripts that exercise the full embedded engine (replay,
suspend/resume, parent/child, batch, retry, abort, cron, crash recovery,
lease fencing).

Everything here is **embedded**: the SDK talks straight to Postgres via
`DATABASE_URL` (default `postgres://localhost:5432/better_trigger`). No
server, no HTTP — one process is enough.

## What's inside

| File | Demonstrates |
|---|---|
| `src/tasks.ts` | The example task set (one feature per task — see table below). |
| `src/trigger.ts` | `betterTrigger({ database })` — the shared embedded instance. |
| `src/worker.ts` | `trigger.start({ tasks, concurrency: 5 })` — claims + executes in-process. |
| `scripts/e2e.ts` | End-to-end assertions through the instance API (self-provisions its db). |
| `scripts/crash.ts` + `scripts/crash-worker.ts` | Crash recovery: 3 SIGKILLs, exactly-once durable steps. |
| `scripts/fencing.ts` | Kernel-level lease/fencing test: 6 fenced ops rejected with zero state change, token monotonic across suspend/resume. |
| `scripts/worker-lost.ts` + `scripts/worker-lost-worker.ts` | Reaper terminal-fail: child dies of `worker lost` at max attempts, waiting parent is woken with `ok: false`. |

### Example tasks (`src/tasks.ts`)

| Task id | Demonstrates |
|---|---|
| `hello-world` | Minimal `task(id, fn)` signature. |
| `order-pipeline` | zod schema + 3 sequential `ctx.step`s + `ctx.now`/`ctx.uuid` + logger; replay memory. |
| `onboarding-wait` | `ctx.wait.for("3s")` suspend → resume between two steps. |
| `video-pipeline` + `extract-audio` | `triggerAndWait` (parent/child) + `unwrapResult`. |
| `fan-out` | `batchTrigger` dispatching 3 `hello-world` children. |
| `flaky-task` | Fails attempts 1–2, succeeds on attempt 3; `retry: { maxAttempts: 3, baseMs: 500 }`. |
| `always-aborts` | Throws `AbortError` → fails immediately, no retry. |
| `parallel-steps` | Two `ctx.step`s under `Promise.all` — per-step log attribution. |
| `every-minute` | `cron: "* * * * *"` — registers a schedule row. |

## Running the worker

You need a Postgres database. From the **repo root** (after a one-time
`bun install && bun run build`):

```bash
createdb better_trigger        # one-time; migrations run automatically
export DATABASE_URL=postgres://localhost:5432/better_trigger
bun run --filter @better-trigger/example-basic worker
# registers all example tasks, starts orchestrator loops, executes runs
```

Trigger a run from any other script/process on the same database:

```ts
import { trigger } from './src/trigger';

const handle = await trigger.trigger('hello-world', { name: 'ada' });
console.log(await handle.result()); // { status: 'completed', output: 'hi ada' }
```

## Acceptance scripts

Each script **provisions its own scratch database** (DROP/CREATE against the
`postgres` admin db derived from `DATABASE_URL`), spins up everything it
needs in-process and exits non-zero on any failed assertion:

```bash
export DATABASE_URL=postgres://localhost:5432/better_trigger

bun run --filter @better-trigger/example-basic e2e      # 12 checks, db better_trigger_e2e
bun run --filter @better-trigger/example-basic crash    # 3 kill points, db better_trigger_crash
bun run --filter @better-trigger/example-basic fencing  # stale-lease rejection, db better_trigger_fencing
```

Each check prints `✓`/`✗` with its elapsed time and a final summary.

## Watch it in the dashboard (optional)

The dashboard is the only part that still uses HTTP — start the dashboard API
server against the same database, then the web app:

```bash
export DATABASE_URL=postgres://localhost:5432/better_trigger
bun run --filter @better-trigger/server start          # dashboard API on :4848

export VITE_BT_API_URL=http://localhost:4848
bun run --filter @better-trigger/web dev
# open the printed URL → Tasks / Runs / Run detail / Schedules show live data
```
