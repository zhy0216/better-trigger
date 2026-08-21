# Embedded mode

When **one process is the product** — a long-lived Node/Bun application such as
a server, CLI or agent host — you can start the same runtime in-process instead
of running a separate daemon. No second process, no open port, no second
execution model.

```ts
import { createEmbeddedRuntime } from "@better-trigger/worker/embedded";
import { hello } from "./tasks";

const runtime = await createEmbeddedRuntime({
  databaseUrl: process.env.DATABASE_URL,
  tasks: [hello],
  concurrency: 5,
});

// createEmbeddedRuntime makes runtime.client the default, so TaskHandle APIs
// keep the same shape as daemon mode.
const handle = await hello.trigger({ name: "ada" });
console.log((await handle.result()).output);

// Wire this into the host framework's graceful-shutdown hook.
await runtime.stop();
```

## What the runtime owns

`createEmbeddedRuntime()` runs the same lifecycle as the daemon CLI:

- applies migrations (configurable),
- registers tasks and claims runs straight from Postgres,
- starts the claim, heartbeat, wait/timer, cron and reaper loops,
- exposes `client`, `app`, `fetch`, `worker` counters and `pool`,
- drains and releases claims on `stop()`.

It never creates a TCP listener. The SDK connects through an **in-process
fetch adapter** that reuses the same Hono API routes.

## Sharing the application pool

Pass an existing `pool` to share the application's connection pool; injected
pools are not closed unless `closePoolOnStop: true` is set. With a
`databaseUrl`, the runtime owns its pool. One embedded runtime may be active
per process, because task context and in-run result resolution use the
process-wide SDK registry.

## What embedded mode does *not* change

Embedded mode removes the extra OS process, **not** the need for an online
worker:

- When the application is stopped, durable state remains in Postgres, but
  tasks, timers and cron do **not** execute.
- Task execution shares the host's CPU, memory and failure domain.

It is intended for long-lived hosts, not scale-to-zero request functions. Use
the standalone daemon when you want isolation or independent scaling.

## Choosing between daemon and embedded

| | Daemon (default) | Embedded |
|---|---|---|
| Process | separate daemon | in your app |
| Port | `:4848` HTTP + dashboard | none (in-process fetch) |
| Isolation / scaling | independent | shares host resources |
| Right fit | multi-node, shared Postgres, ops isolation | one long-lived app process |
