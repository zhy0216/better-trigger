# @better-trigger/example-basic

SDK usage examples for [`better-trigger`](../../packages/sdk) plus an
end-to-end smoke test that exercises the full engine (replay, suspend/resume,
parent/child, batch, retry, abort, cron).

Everything here points at a running server via `BETTER_TRIGGER_API_URL`
(default `http://localhost:4848`).

## What's inside

| File | Demonstrates |
|---|---|
| `src/tasks.ts` | The example task set (one feature per task — see table below). |
| `src/worker.ts` | `startWorker({ tasks, concurrency: 5 })` — registers + long-polls. |
| `scripts/e2e.ts` | End-to-end assertions over the HTTP API (contract §8, item 3). |

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
| `every-minute` | `cron: "* * * * *"` — registers a schedule row. |

## Running it (three terminals)

You need a Postgres database and the better-trigger server. From the **repo
root** (after a one-time `bun install` at integration time):

### 0. One-time: create the database

```bash
createdb better_trigger
# or: psql -c 'CREATE DATABASE better_trigger;'
```

The server runs migrations automatically on startup.

### Terminal 1 — server

```bash
export DATABASE_URL=postgres://localhost:5432/better_trigger
bun run --filter @better-trigger/server start
# server listening on http://localhost:4848
```

### Terminal 2 — worker

```bash
export BETTER_TRIGGER_API_URL=http://localhost:4848
bun run --filter @better-trigger/example-basic worker
# registers all example tasks, then long-polls for runs
```

### Terminal 3 — trigger a run / run the e2e suite

Trigger one task by hand:

```bash
curl -s localhost:4848/api/v1/trigger \
  -H 'content-type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'
# → {"runId":"run_...","idempotent":false}
```

Or run the full end-to-end smoke test (server + worker must already be up):

```bash
export BETTER_TRIGGER_API_URL=http://localhost:4848
bun run --filter @better-trigger/example-basic e2e
```

Each check prints `✓`/`✗` with its elapsed time and a final summary; any
failure exits non-zero.

### Watch it in the dashboard

```bash
export VITE_BT_API_URL=http://localhost:4848
bun run --filter @better-trigger/web dev
# open the printed URL → Tasks / Runs / Run detail / Schedules show live data
```

## Auth

If the server sets `BETTER_TRIGGER_API_KEY`, export the same value for the
worker and the e2e script — both send it as `Authorization: Bearer <key>`.
Unset = local mode, no auth.
