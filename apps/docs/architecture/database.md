# Database

One Postgres database holds everything: the queue, run ledgers, step memory,
waits, logs, schedules and the worker registry. The schema is defined in
`packages/db` with Drizzle and applied as generated SQL migrations — daemons
auto-migrate at boot (`--no-migrate` to disable).

## Tables

```mermaid
erDiagram
    TASKS ||--o{ RUNS : "creates"
    RUNS ||--o{ RUN_STEPS : "owns (CASCADE)"
    RUNS ||--o{ WAITS : "owns (CASCADE)"
    RUNS ||--o{ LOGS : "owns (CASCADE)"
    RUNS ||--o{ QUEUE : "has (CASCADE)"
    TASKS ||--o{ SCHEDULES : "cron (CASCADE)"
    RUNS ||--o{ RUNS : "parent/child (SET NULL)"

    TASKS {
        text id PK
        text name
        jsonb retry
        int concurrency_limit
        text latest_code_version
        timestamptz created_at
    }
    RUNS {
        text id PK "run_..."
        text task_id FK
        text status "queued|running|waiting|completed|failed|canceled"
        jsonb payload
        jsonb output
        jsonb error
        text parent_run_id FK "SET NULL"
        text idempotency_key UK "unique per task"
        bigint fencing_token "bumped on every claim"
        int attempt
        int max_attempts
        int recoveries
        int max_recoveries
        text concurrency_key
        int priority
        text code_version
    }
    RUN_STEPS {
        text run_id PK "with seq"
        int seq PK
        text kind "step|wait|trigger-and-wait|batch-trigger|now|random|uuid"
        text label
        text status "completed|failed"
        jsonb output
        jsonb error
        int attempt
    }
    QUEUE {
        bigint id PK
        text run_id UK "unique; FK to runs"
        timestamptz available_at
        int priority
        text locked_by
        timestamptz lease_until
        text concurrency_key
    }
    WAITS {
        bigint id PK
        text run_id FK
        int step_seq
        text kind "duration|until|run"
        timestamptz resume_at
        text child_run_id FK "SET NULL"
        text status "pending|completed|canceled"
    }
    LOGS {
        bigint id PK
        text run_id FK
        int step_seq
        text level "debug|info|warn|error"
        text message
        jsonb data
    }
    SCHEDULES {
        text id PK "sch_..."
        text task_id UK "unique; FK to tasks"
        text cron_pattern
        text cron_tz
        boolean enabled
        timestamptz next_run_at
    }
    WORKERS {
        text id PK "wkr_..."
        text name
        text code_version
        jsonb tasks
        int concurrency
        text status "online|offline"
        timestamptz last_heartbeat_at
    }
```

Key design points:

- **`fencing_token` lives on `runs`, not on the queue row.** The queue row is
  deleted and recreated on retry/resume, but the token must be monotonic for
  the run's whole life.
- **FK behavior is deliberate.** `runs.parent_run_id` and `waits.child_run_id`
  are `ON DELETE SET NULL` (a deleted child must not cascade-kill a running
  parent); `run_steps` / `waits` / `logs` / `queue` cascade from `runs`, so any
  delete path (prune, CLI, manual `psql`) leaves no orphans.
- **`queue.locked_by IS NULL` is the only "not occupied" test** — not
  `locked_at`. Expired leases are the reaper's job alone; claim and reaper
  candidate sets are disjoint.
- **Two partial indexes** keep the hot scans narrow:
  - `queue_claimable_idx (priority DESC NULLS FIRST, id) WHERE locked_by IS NULL`
  - `queue_lease_until_idx (lease_until) WHERE lease_until IS NOT NULL`

## The claim query

Claiming is one transaction, and one SQL statement pulls every column a run
needs (payload, attempts, versions, concurrency limits) to avoid N+1:

```sql
SELECT q.id AS queue_id, q.run_id,
       r.task_id, r.payload, r.attempt, r.max_attempts,
       r.code_version, r.env, r.concurrency_key,
       t.concurrency_limit
  FROM queue q
  JOIN runs r ON r.id = q.run_id
  LEFT JOIN tasks t ON t.id = r.task_id
 WHERE q.available_at <= now() AND q.locked_by IS NULL
   AND r.task_id = ANY($1::text[])   -- the tasks THIS worker registered
 ORDER BY q.priority DESC, q.id ASC
 LIMIT $2                            -- claimWindow = max(limit * 2, 10)
 FOR UPDATE OF q SKIP LOCKED
```

The task filter lives **in SQL**, so a worker that registered two tasks never
wastes its candidate window on someone else's queue head. Task-level
code-version pinning (`--pin-code-version`) extends the filter to `(id,
version)` pairs, so a mid-flight edit never hands a run to code that cannot
replay its ledger.

## Retention

The engine never deletes history unless you ask:

- `--retention 30d` turns on an hourly GC of terminal runs (steps and logs
  cascade) and offline worker rows.
- `better-trigger-worker prune --older-than 30d [--dry-run]` is the one-shot
  form.

Non-terminal runs are never deleted at any age — a stuck run is a bug to look
at, not garbage.
