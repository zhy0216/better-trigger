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
| `scripts/e2e.ts` | End-to-end assertions through the HTTP client (self-provisions its db, spawns one daemon). |
| `scripts/crash.ts` + `scripts/crash-tasks.ts` | Crash recovery: 3 SIGKILLs of the executor node, exactly-once durable steps. |
| `scripts/fencing.ts` | Kernel-level lease/fencing test (no daemon, no HTTP): 6 fenced ops rejected with zero state change, token monotonic across suspend/resume. |
| `scripts/replay-drift.ts` + `scripts/replay-drift-tasks-v{1,2}.ts` | Mid-flight redeploy: `code_version` stamping, body fingerprinting, `replay: 'strict'` refusing a drifted ledger. |
| `scripts/worker-lost.ts` + `scripts/worker-lost-tasks.ts` | Reaper recovery then terminal-fail: the first lost worker costs a `recovery` and not the child's only attempt, the second exhausts the recovery budget → `worker lost`, waiting parent woken with `ok: false`. |
| `scripts/retention.ts` | Data retention through the FK cascades: a manual `DELETE FROM runs` takes steps/logs with it, the 0007 migration survives a database full of orphans, and the real `prune` CLI. |
| `scripts/stats.ts` | The `/tasks` stats window is real: runs created 26h ago never leak into the 24h p50/p95/successRate, `lastRunAt` stays all-history, and a no-run task renders zero/null. |
| `scripts/notify.ts` + `scripts/notify-tasks.ts` | The notification fast-path (PF2): a fresh run is claimed without the idle backoff, 8 concurrent `result()` waiters settle through the in-process registry, killing the daemons' LISTEN backends degrades to polling and reconnects, and duplicate notifications never duplicate a run. |
| `scripts/claim-scan-bench.ts` | Plan bench, not a correctness scenario: `EXPLAIN (ANALYZE, BUFFERS)` of the claim candidate scan over a 50k-row backlog, with and without `queue_claimable_idx`. |
| `scripts/stats-bench.ts` | Plan bench: `EXPLAIN (ANALYZE, BUFFERS)` of the `/tasks` aggregation over ~1M runs (95% predating the 24h window), with and without `runs_created_idx`. |
| `scripts/retention.ts` | Data retention through the FK cascades: a manual `DELETE FROM runs` takes steps/logs with it, the 0007 migration survives a database full of orphans, and the real `prune` CLI. |
| `scripts/constraints.ts` | C5 database-level constraints: the five FKs (queue/waits.run_id cascade, `parent_run_id` + `child_run_id` SET NULL, schedules→tasks cascade) and the ten CHECK enums actually fire — a manual run delete leaves no orphan, a deleted child run's parent is failed by the orchestrator instead of stranded, an illegal status is refused with 23514, the 0011 migration cleans orphans instead of bricking daemon boots, and prune/cancel/retry keep every relation intact. |
| `scripts/health-pool.ts` | PF4 probe pool on a live Postgres: `statement_timeout` is server-side effective (pg_settings says 1000ms), a never-returning probe (`SELECT pg_sleep(30)`) is cancelled at ~1s with 57014 `query_canceled` and the connection returns (consecutive probes never exhaust max=2), concurrent probes queue through max=2 without losing work, and 10 concurrent `/metrics` scrapes against a real daemon share one lock-blocked gauge query (single-flight) instead of piling up on the probe pool. |

The scaffolding every scenario shares — database provisioning, daemon spawn /
health-wait / SIGKILL, polling, the marker-file probe, the scenario runner and
the durable-execution invariant assertions — lives in
[`@better-trigger/testing`](../../packages/testing), not in this directory. A
new scenario is a `runScenario()` call, not a copy of a neighbouring script.

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

bun run --filter @better-trigger/example-basic e2e           # 18 checks · db _e2e · :4901
bun run --filter @better-trigger/example-basic fencing       # 22 checks · db _fencing · no daemon
bun run --filter @better-trigger/example-basic replay-drift  # 17 checks · db _drift · :4903
bun run --filter @better-trigger/example-basic crash         # 14 checks · db _crash · :4902
bun run --filter @better-trigger/example-basic worker-lost   #  8 checks · db _worker_lost · :4904
bun run --filter @better-trigger/example-basic stats         #  4 checks · db _stats · :4906
bun run --filter @better-trigger/example-basic notify        #  4 checks · db _notify · :4907
bun run --filter @better-trigger/example-basic constraints    #  8 checks · db _constraints · no daemon
bun run --filter @better-trigger/example-basic health-pool    #  4 checks · db _health_pool · daemon (part 4)

bun run test:acceptance                                      # all thirteen, one exit code
```

`crash`, `worker-lost` and `replay-drift` run **two** daemons: an API node (no
`--tasks`) that serves the scenario's client and keeps a lease reaper alive
across every kill, plus an executor node (`--tasks ... --no-serve`) that is the
one being killed.

Each check prints `✓`/`✗` with its elapsed time and a final summary.

The benches use the same harness but are **not** in `test:acceptance` — they
assert a query *plan*, not durable-execution behaviour, and they seed tens of
thousands of rows to do it. Run them by hand after touching the claim query /
`queue` indexes, or the stats aggregation / `runs` indexes:

```bash
bun run --filter @better-trigger/example-basic bench:claim-scan  # 3 checks · db _claim_scan · no daemon
bun run --filter @better-trigger/example-basic bench:stats       # 3 checks · db _stats_bench · no daemon
BT_STATS_ROWS=200000 bun run --filter @better-trigger/example-basic bench:stats  # smaller, faster
```

## Watch it in the dashboard

The daemon already serves the dashboard API, so only the web app is missing:

```bash
export VITE_BT_API_URL=http://localhost:4848
bun run --filter @better-trigger/web dev
# open the printed URL → Tasks / Runs / Run detail / Schedules show live data
```
