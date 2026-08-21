# CLI & environment

The daemon binary is `better-trigger-worker`. Every flag has an environment
variable equivalent, and vice versa. Run `better-trigger-worker --help` for the
authoritative list — the help text is generated from the same registry
(`apps/worker/src/env-registry.ts`) that a CI test keeps in sync with the
source.

## CLI flags

```
--tasks <path>           Module exporting task() handles (repeatable / comma-separated)
--port <n>               HTTP port                    (env PORT, default 4848)
--host <addr>            Bind address                 (env BETTER_TRIGGER_HOST, default 127.0.0.1)
--allow-unauthenticated  Permit a non-loopback --host without an API key
--cors-origin <origin>   Extra browser origin allowed to call the API (repeatable / `*`)
--concurrency <n>        Concurrent execution slots   (env BETTER_TRIGGER_CONCURRENCY, default 5)
--name <s>               Worker name shown in the dashboard
--lease-ms <n>           Claim lease duration         (default 60000)
--timer-interval-ms <n>  Wait-due scan interval       (default 1000)
--cron-interval-ms <n>   Cron scan interval           (default 1000)
--reaper-interval-ms <n> Expired-lease reap interval  (default 10000)
--retention <duration>   Turn ON the retention GC loop ("30d", "72h")
--gc-interval-ms <n>     Retention GC interval        (default 3600000)
--pin-code-version       Claim only runs whose code version this process serves
--stranded-interval-ms <n> Stranded-run scan interval (default 30000)
--database-url <s>       Postgres connection string   (env DATABASE_URL)
--no-migrate             Skip applying migrations at boot
--no-serve               Execute without serving HTTP
-h, --help               Show this help
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/better_trigger` | Postgres connection string |
| `PORT` | `4848` | HTTP listen port |
| `BETTER_TRIGGER_HOST` | `127.0.0.1` | Bind address (loopback by default) |
| `BETTER_TRIGGER_ALLOW_UNAUTHENTICATED` | _(unset)_ | `1`/`true` = `--allow-unauthenticated` |
| `BETTER_TRIGGER_CORS_ORIGIN` | _(unset)_ | Extra browser origins, comma-separated |
| `BETTER_TRIGGER_NAMESPACES` | `default/prod` | Namespaces this worker serves, comma-separated `<projectId>/<env>` |
| `BETTER_TRIGGER_CONCURRENCY` | `5` | Concurrent execution slots |
| `BETTER_TRIGGER_BODY_LIMIT` | `1048576` | Max request body bytes → `413` |
| `BETTER_TRIGGER_MAX_BATCH` | `500` | Max items in one `batchTrigger` → `400` |
| `BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES` | `1048576` | Max total payload across a `batchTrigger` → `400` |
| `BETTER_TRIGGER_MAX_PAYLOAD_BYTES` | `262144` | Max serialized payload per run → `413` |
| `BETTER_TRIGGER_MAX_STEPS` | `10000` | Replayed step ledger cap; past it the run is truncated + non-retryable (`0` = unlimited) |
| `BETTER_TRIGGER_MAX_RECOVERIES` | `10` | Reaper recovery budget stamped on new runs (`0` = never recover) |
| `BETTER_TRIGGER_POOL_MAX` | _derived_ | Business-pool max (`--concurrency + 8`) |
| `BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS` | `10000` | Pool checkout / connect timeout |
| `BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS` | `30000` | Server-side `statement_timeout` |
| `BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION` | _(unset)_ | `1` = make stray `unhandledRejection`s fatal |
| `BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES` | `262144` | Max step output/error per row |
| `BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES` | `262144` | Max serialized run output |
| `BETTER_TRIGGER_ERROR_MAX_BYTES` | `65536` | Max serialized error record |
| `BETTER_TRIGGER_LOG_DATA_MAX_BYTES` | `16384` | Max serialized `data` on one log line |
| `BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES` | `65536` | Max serialized message on one log line |
| `BETTER_TRIGGER_LOG_BATCH_MAX_BYTES` | `262144` | Max serialized payload of one log INSERT |
| `BETTER_TRIGGER_STATS_TTL_MS` | `10000` | `/tasks` stats cache TTL |
| `BETTER_TRIGGER_API_KEY` | _(unset)_ | When set, every `/api/v1/*` call except `/health` needs `Authorization: Bearer <key>` |
| `BETTER_TRIGGER_API_KEYS` | _(unset)_ | Additional bearer keys, comma-separated, optional `@<date>` expiry |
| `BETTER_TRIGGER_RATE_LIMIT_RPS` | `50` | Per-key per-endpoint write rate (tokens/s) |
| `BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS` | `200` | Per-endpoint global write rate |
| `BETTER_TRIGGER_RATE_LIMIT_READ_RPS` | `200` | Per-key read rate |
| `BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS` | `1000` | Global read rate |
| `BETTER_TRIGGER_RATE_LIMIT_BURST` | _larger write rate_ | Token-bucket capacity |
| `BETTER_TRIGGER_PIN_CODE_VERSION` | _(unset)_ | `1`/`true` = `--pin-code-version` |
| `BETTER_TRIGGER_VERSION` | _(build identity)_ | Code version reported on registration (overrides per-task versions) |

Set any rate-limit knob to `0` to disable that bucket. An absent, zero,
negative or unparseable value falls back to the default rather than switching a
cap off.
