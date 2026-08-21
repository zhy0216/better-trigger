# Running the daemon

`better-trigger-worker` is the all-in-one daemon: it imports your task modules,
applies database migrations, executes runs with the replay executor, runs the
orchestrator loops (waits / cron / lease reaper / offline markers) and serves
the HTTP API — plus the built-in dashboard — on one port.

```bash
# From a checkout, after `bun install && bun run build`:
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

The daemon `import()`s your `--tasks` modules, so **TypeScript entries require
a TS runtime** — run it under `bun` (as above) or `tsx`, or point `--tasks` at
compiled JavaScript.

## Deployment shapes

`--tasks` and `--no-serve` are independent, so one binary covers every shape:

| Command | Role |
|---|---|
| `better-trigger-worker --tasks ./tasks.ts` | all-in-one: executes + serves (default) |
| `better-trigger-worker` | API + dashboard only; runs the lease reaper + offline markers, but **not** cron/waits/claim |
| `better-trigger-worker --tasks ./tasks.ts --no-serve` | executor-only node |

Run any number of daemons against one database — every claim and scan uses
`FOR UPDATE SKIP LOCKED`, so there is **no leader election**. A typical
multi-node deployment is one API/dashboard node plus several `--no-serve`
executor nodes.

## Task loading

Every export of a `--tasks` module that looks like a `task()` handle is
registered, including handles inside exported arrays:

```ts
export const hello = task("hello", async () => "hi");
export const allTasks = [hello, onboarding];   // also works
```

`--tasks` is repeatable and accepts comma-separated paths. Duplicate task ids
across modules are an error unless they are literally the same handle.

## Dashboard

The daemon serves the built dashboard itself — same origin as the API, no
second port, no CORS. `docker compose up` and open `http://127.0.0.1:4848`. A
deep link (e.g. a `/runs/...` URL you bookmarked) refreshes to the dashboard
instead of a 404, and hashed assets are served `immutable` so a daemon restart
always hands out the new bundle.

For dashboard development, run Vite standalone and point it at the daemon:

```bash
cd apps/web && VITE_BT_API_URL=http://localhost:4848 bun run dev   # :5173
```

If the daemon uses `BETTER_TRIGGER_API_KEY`, the dashboard prompts for a key
after a `401` and keeps a manually entered token only in page memory — it is
never stored in browser storage or cookies.

## Graceful shutdown

`SIGINT` / `SIGTERM` shut the daemon down gracefully: stop claiming → drain
in-flight runs → stop the loops → close the server → end the pool. A clean
restart hands claims back without spending a retry attempt — `attempt` (the
budget for *your code* failing) and `recoveries` (the budget for infrastructure
takeovers) are both untouched.

## What happens when a worker dies

Each claim carries a **fencing token** — a per-run monotonic counter bumped on
every claim. If a daemon dies, its leases expire (`--lease-ms`, default 60s)
and are reaped by any surviving daemon; late writes from the zombie worker are
rejected by the fencing check. This is what keeps step history exactly-once.

A lost worker's runs are taken over and cost one **recovery** (budget
`max_recoveries`, default 10) — not an attempt. Only an exhausted recovery
budget terminates the run with `worker lost`.

## CLI & environment

Everything is configurable via flags and `BETTER_TRIGGER_*` environment
variables. Notable knobs:

```bash
better-trigger-worker --tasks ./tasks.ts \
  --port 4848 --concurrency 5 --name worker-1 --lease-ms 60000 \
  --pin-code-version        # claim only runs whose code version this process serves
  --retention 30d           # turn ON the hourly history GC
```

See [CLI & environment](/reference/cli-and-env) for the full table, and
`better-trigger-worker --help` for the authoritative list.
