# Quick start

The fastest way to see better-trigger working is `docker compose` — it starts
Postgres **and** a daemon already running the example tasks, including a cron
task that fires every two seconds, so there is something executing from the
first command. The example is baked into the worker image, so nothing needs to
be installed or built on your machine first:

```bash
docker compose up -d   # postgres:16 + the daemon on 127.0.0.1:4848

curl localhost:4848/api/v1/tasks   # the example tasks, registered
curl localhost:4848/api/v1/runs    # …and the cron runs they are already producing
curl -X POST localhost:4848/api/v1/trigger \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'
```

The [dashboard](/guide/running-the-daemon#dashboard) points at
`http://localhost:4848` and shows all of it.

## Run your own tasks

Or keep the daemon on your machine:

```bash
bun install && bun run build
createdb better_trigger      # or: docker compose up -d postgres
```

```ts
// tasks.ts — imported by the daemon, and by your app for type-safe triggers
import { task } from "better-trigger";

export const hello = task({
  id: "hello-world",
  run: async (payload: { name: string }) => `hello, ${payload.name}`,
});
```

Start the daemon — it loads `tasks.ts`, applies migrations, executes runs and
serves the API on `:4848`:

```bash
DATABASE_URL=postgres://localhost:5432/better_trigger \
  bunx --bun @better-trigger/worker --tasks ./tasks.ts
```

Then trigger from anywhere:

```ts
// app.ts — no database, no execution loop
import { betterTrigger } from "better-trigger";
import { hello } from "./tasks";

betterTrigger({ url: "http://localhost:4848" }).setDefault();

const handle = await hello.trigger({ name: "ada" });
const result = await handle.result();   // { status: "completed", output: "hello, ada" }
console.log(result.output);             // "hello, ada" — typed as the task's return value
```

## A note on `handle.result()`

`handle.result()` waits for a terminal state. A run that takes longer than the
wait budget (30s by default) returns its **latest non-terminal status** instead
of the output — always check `result.status` if the run may run long, or pass
`{ throwOnTimeout: true }` to make the timeout throw `ResultTimeoutError` (with
the latest status) instead.

## Requirements

- Node.js 18+ (or Bun) for the SDK and the daemon.
- A reachable PostgreSQL database (16+ recommended).

The daemon runs your TypeScript task modules directly under `bun`. Under plain
`node`, point `--tasks` at compiled JavaScript (or use a loader such as `tsx`).
