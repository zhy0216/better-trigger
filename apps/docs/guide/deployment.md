# Deployment & security

The daemon is designed to be run **locally first** and hardened for network
exposure when you need it. This page covers the security model, limits and
operational knobs. The full environment-variable table lives in
[CLI & environment](/reference/cli-and-env).

## Network posture

The API binds `127.0.0.1` and is unauthenticated by default — so "local" has to
mean local. Setting `BETTER_TRIGGER_API_KEY` makes every `/api/v1` call (except
`/health`) require `Authorization: Bearer <key>`; the SDK takes the same value.

A non-loopback `--host` **without** a key refuses to start unless
`--allow-unauthenticated` explicitly says the exposure is deliberate. Browser
origins are loopback-only by default; add others with `--cors-origin`.

### Multiple keys + rotation

`BETTER_TRIGGER_API_KEYS` adds keys alongside the primary, each optionally
carrying a `key@2030-01-01` expiry suffix (past it: `401 key_expired`).
Rotation is coexistence: add the new key, let old requests drain, remove the
old one.

```bash
BETTER_TRIGGER_API_KEY=sk-old-aaaaaaaa \
BETTER_TRIGGER_API_KEYS=sk-new-bbbbbbbb better-trigger-worker --host 0.0.0.0
```

### Rate limiting

`trigger` / `batch-trigger` / `retry` / `cancel` are token-bucket limited per
key and per endpoint (defaults 50/s and 200/s), answered `429 rate_limited`.
Reads are bucketed too, but loosely (defaults 200/s per key, 1000/s over all
keys). The buckets are in-memory per process; for an exact fleet-wide cap,
rate-limit at the reverse proxy.

### Audit log

Every `/api/v1` request writes one structured JSON line to stdout with
`requestId`, a key fingerprint, caller, task/run ids, status and rejection
reason. Payloads and `Authorization` headers are never recorded. The
`requestId` doubles as the production-500 correlation id and the
`x-request-id` response header.

## TLS / proxy / DB

- Terminate TLS at a reverse proxy in front of the daemon (nginx, Caddy,
  Traefik, ALB) — the daemon speaks plain HTTP.
- Never trust `X-Forwarded-For` for enforcement or auditing (it is spoofable);
  the audit log records the TCP peer only.
- Keep Postgres reachable only by the daemon. The SDK never opens a database
  connection, so "app may not touch the DB" is a network rule, not a code rule.

## Limits

All overridable by env (see the reference):

| Cap | Default |
|---|---|
| Request body | 1 MiB → `413 payload_too_large` |
| `batchTrigger` items | 500 → `400 bad_request` |
| Serialized payload per run | 256 KiB → `413 payload_too_large` |
| Step / run output | 256 KiB each |
| Error record | 64 KiB |
| Log-line `data` | 16 KiB |

A value JSON cannot represent (circular structure, BigInt) is refused with
`400 serialization_error` naming the field — never a raw `TypeError` that would
read as a 500. Keep large objects in object storage and pass a **reference** in
the payload.

## Observability

- `GET /api/v1/health` is always open and answers `{ ok, version, sha? }`;
  `?deep=1` adds a DB probe and pool stats (`503` when the DB is down).
- `GET /api/v1/metrics` renders Prometheus text — queue depth, in-flight runs,
  run outcomes, claim/heartbeat error counters, reaper recoveries, build info.
- See [Metrics](/reference/metrics) for the full list.

## Retention

Retention is **off by default** — the daemon deletes no history unless asked.
`--retention 30d` turns on an hourly GC that removes terminal runs (steps and
logs cascade) and offline worker rows past the window. One-shot instead:

```bash
better-trigger-worker prune --older-than 30d --dry-run   # report, delete nothing
better-trigger-worker prune --older-than 30d
```

Queued / running / waiting runs are never deleted at any age, and neither are
tasks or schedules.
