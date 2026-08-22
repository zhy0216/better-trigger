---
layout: home

hero:
  name: better-trigger
  text: Durable execution for TypeScript, on Postgres
  tagline: Replay-based background tasks, cron, retries and fan-out — with one Postgres database. No Redis, no ClickHouse, no second runtime.
  image:
    src: /logo.svg
    alt: better-trigger
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/zhy0216/better-trigger

features:
  - icon: 🧱
    title: Replay, not snapshots
    details: Completed steps are memoized in Postgres. After a crash or a long wait, the task re-runs from the top and cached steps return instantly — your code stays a straight-line async function.
  - icon: 🐘
    title: Postgres is the only infra
    details: Queue, orchestrator loops and the replay executor all live in the runtime and coordinate with FOR UPDATE SKIP LOCKED. N daemons against one database, no leader election.
  - icon: 📦
    title: Zero-dependency SDK
    details: better-trigger ships task() and an HTTP client with no runtime dependencies. It never opens a database connection, so it is safe to import into a web server, CLI, edge function or browser.
  - icon: 🧩
    title: One process or many
    details: Run the worker as a standalone daemon, embed the same runtime in a long-lived Node/Bun app, or run any number of daemons against the same database.
  - icon: 🔁
    title: Durable primitives
    details: Retries with backoff, idempotency keys, cron, concurrency limits, waits, parent/child triggerAndWait and batchTrigger — all recoverable across crashes.
  - icon: 🛡️
    title: Crash-safe by construction
    details: Persistent leases plus a monotonic fencing token reject late writes from a dead worker, so step history stays exactly-once.
---

## One command to try it

```bash
docker compose up -d   # postgres:16 + the daemon on 127.0.0.1:4848

curl localhost:4848/api/v1/tasks   # the example tasks, registered
curl -X POST localhost:4848/api/v1/trigger \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"hello-world","payload":{"name":"ada"}}'
```

The example is baked into the worker image — nothing needs to be installed or
built on your machine first, and a cron task is already producing runs.
