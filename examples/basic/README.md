# @better-trigger/example-basic

SDK usage examples for [`better-trigger`](../../packages/sdk) plus the
end-to-end acceptance scripts that exercise the full engine (replay,
suspend/resume, parent/child, batch, retry, abort, cron, crash recovery,
lease fencing).

The split mirrors production: `src/tasks.ts` is loaded by the **worker daemon**,
while `src/trigger.ts` is the HTTP client an application would hold. Only the
daemon (and the harnesses' direct-SQL assertions) ever sees `DATABASE_URL`.

## What's inside

| File | Demonstrates |
|---|---|
| `src/tasks.ts` | The example task set (one feature per task — see table below). Loaded via `--tasks`. |
| `src/trigger.ts` | `betterTrigger({ url })` — the shared HTTP client. |
| `scripts/daemon.ts` | Spawn / health-wait / kill helpers used by every harness. |
| `scripts/e2e.ts` | End-to-end assertions through the HTTP client (self-provisions its db, spawns one daemon). |
| `scripts/crash.ts` + `scripts/crash-tasks.ts` | Crash recovery: 3 SIGKILLs of the executor node, exactly-once durable steps. |
| `scripts/fencing.ts` | Kernel-level lease/fencing test (no daemon, no HTTP): 6 fenced ops rejected with zero state change, token monotonic across suspend/resume. |
| `scripts/worker-lost.ts` + `scripts/worker-lost-tasks.ts` | Reaper terminal-fail: child dies of `worker lost` at max attempts, waiting parent is woken with `ok: false`. |

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
| `every-minute` / `every-2s` | `cron` — registers a schedule row and fires it. |

## Running the daemon

You need a Postgres database. From the **repo root** (after a one-time
`bun install && bun run build`):

```bash
createdb better_trigger        # one-time; migrations run automatically
export DATABASE_URL=postgres://localhost:5432/better_trigger
bun run --filter @better-trigger/example-basic worker
# → better-trigger-worker --tasks src/tasks.ts
# registers all example tasks, starts the orchestrator loops, serves :4848
```

Trigger a run from any other script/process:

```ts
import { trigger } from './src/trigger';

const handle = await trigger.trigger('hello-world', { name: 'ada' });
console.log(await handle.result()); // { status: 'completed', output: 'hi ada' }
```

## Acceptance scripts

Each script **provisions its own scratch database** (DROP/CREATE against the
`postgres` admin db derived from `DATABASE_URL`), spawns whatever daemons it
needs on its own port, and exits non-zero on any failed assertion:

```bash
export DATABASE_URL=postgres://localhost:5432/better_trigger

bun run --filter @better-trigger/example-basic e2e          # 13 checks · db _e2e · :4901
bun run --filter @better-trigger/example-basic crash        # 11 checks · db _crash · :4902
bun run --filter @better-trigger/example-basic fencing      # 20 checks · db _fencing · no daemon
bun run --filter @better-trigger/example-basic worker-lost  #  6 checks · db _worker_lost · :4904
```

`crash` and `worker-lost` run **two** daemons: an API node (no `--tasks`) that
serves the harness's client and keeps a lease reaper alive across every kill,
plus an executor node (`--tasks ... --no-serve`) that is the one being killed.

Each check prints `✓`/`✗` with its elapsed time and a final summary.

## Watch it in the dashboard

The daemon already serves the dashboard API, so only the web app is missing:

```bash
export VITE_BT_API_URL=http://localhost:4848
bun run --filter @better-trigger/web dev
# open the printed URL → Tasks / Runs / Run detail / Schedules show live data
```
