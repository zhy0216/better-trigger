/* =============================================================================
   @better-trigger/db — Drizzle table definitions.
   SINGLE SOURCE OF TRUTH for the database shape: migrations are generated from
   this file via `bun run db:generate` (drizzle-kit) into ../migrations.
   Authoritative spec: docs/backend-contract.md §2 (+ §3.5 concurrency_key on runs).
   All business tables carry project_id ('default') and env ('prod').
   DB columns are snake_case; the JS object keys are camelCase.
   Referential integrity (C5, todos/01-correctness.md): every relation is a
   real FK — queue/waits.run_id → runs CASCADE, runs.parent_run_id →
   waits.child_run_id → runs SET NULL (a deleted child run must not strand
   its 'waiting' parent; the orchestrator's wait-due scanner fails those
   parents with a ChildLostError), schedules → tasks CASCADE — and
   status/kind/level are CHECK-constrained closed enums; a manual DELETE or a
   hand-written bad status cannot leave orphan rows or unreadable states
   behind. Migration 0011 cleans FK orphans automatically, but CHECK
   constraints assume pre-existing status/kind/level values are already
   in-set (everything this engine writes is): a hand-edited row outside the
   set makes the migration fail, which the operator must resolve by fixing
   the row (the migration's header comment spells out the UPDATEs).
   ============================================================================= */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/* ---------------------------------------------------------------------------
 * tasks — namespace-scoped: PK is (project_id, env, id), so the same task id
 * can exist independently in every namespace (C2, todos/01-correctness.md).
 * ------------------------------------------------------------------------- */
export const tasks = pgTable(
  'tasks',
  {
    id: text('id').notNull(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    name: text('name').notNull(),
    filePath: text('file_path'),
    triggerSource: text('trigger_source').notNull().default('api'),
    cronPattern: text('cron_pattern'),
    cronTz: text('cron_tz'),
    retry: jsonb('retry'),
    concurrencyLimit: integer('concurrency_limit'),
    latestCodeVersion: text('latest_code_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.env, t.id] })],
);

/* ---------------------------------------------------------------------------
 * runs
 * ------------------------------------------------------------------------- */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    taskId: text('task_id').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload'),
    output: jsonb('output'),
    error: jsonb('error'),
    triggerType: text('trigger_type').notNull(),
    // FK to runs, ON DELETE SET NULL (C5, todos/01-correctness.md): a deleted
    // run must not take its still-live children down with it — prune deletes
    // runs one batch at a time and a parent may be pruned while a child is
    // still queued/running. CASCADE would silently delete the child (and, in
    // the same batch, double-delete rows the prune already targeted); RESTRICT
    // would make prune fail the moment a batch contained a parent/child pair.
    // SET NULL orphans the child's lineage field but nothing else — the child
    // is an independent run and keeps executing; its trigger-and-wait step row
    // (already recorded, or absent) does not depend on this column.
    parentRunId: text('parent_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    codeVersion: text('code_version'),
    idempotencyKey: text('idempotency_key'),
    concurrencyKey: text('concurrency_key'),
    attempt: integer('attempt').notNull().default(1),
    maxAttempts: integer('max_attempts').notNull().default(1),
    /** Redundant copy of the queue row's priority (queue.priority is what the
     *  claim scan orders by; this one is never read by the scheduler). The
     *  queue row is deleted the moment a run goes terminal, so without it the
     *  answer to "what priority was this run triggered at?" dies with the run —
     *  which is exactly what a manual retry (C7) and the dashboard need. */
    priority: integer('priority').notNull().default(0),
    /** Infrastructure hand-backs, kept apart from `attempt` on purpose:
     *  attempt/max_attempts is the budget the USER's code may fail through,
     *  recoveries/max_recoveries is how often the reaper may pick this run up
     *  after a worker vanished (deploy, OOM, SIGKILL). Counting both against
     *  max_attempts would let three deploys kill a maxAttempts:3 run. Never
     *  reset — the pair only bounds an endless claim/die loop. */
    recoveries: integer('recoveries').notNull().default(0),
    maxRecoveries: integer('max_recoveries').notNull().default(10),
    /** Monotonic write credential, bumped on every claim. Lives on runs (not
     *  queue) so suspend/resume cycles — which delete and re-insert the queue
     *  row — can never reset the watermark. */
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial UNIQUE backing the idempotent-trigger upsert
    // (ON CONFLICT (project_id, env, task_id, idempotency_key) WHERE
    // idempotency_key IS NOT NULL). Namespace-scoped: the same task + key in
    // two namespaces creates two independent runs (C2).
    uniqueIndex('runs_task_idempotency_uniq')
      .on(t.projectId, t.env, t.taskId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('runs_task_created_idx').on(t.projectId, t.env, t.taskId, t.createdAt),
    index('runs_status_concurrency_idx').on(t.projectId, t.env, t.status, t.concurrencyKey),
    index('runs_created_idx').on(t.projectId, t.env, t.createdAt),
    // C5 (todos/01-correctness.md): status is an enum the whole engine switches
    // on — a row outside the set would be unreadable garbage instead of a state.
    check(
      'runs_status_check',
      sql`${t.status} IN ('queued','running','waiting','completed','failed','canceled')`,
    ),
    // attempt is 1-based and only ever grows (failRun guards attempt <
    // max_attempts before incrementing). max_attempts is deliberately NOT
    // bounded here: a user-supplied retry policy can legitimately be
    // maxAttempts: 0 ("never retry"), which makes attempt (1) > max_attempts —
    // so the cross-column relation is enforced by failRun, not by SQL.
    check('runs_attempt_check', sql`${t.attempt} >= 1`),
    // recoveries is the reaper's separate budget: the reaper terminal-fails
    // the moment recoveries >= max_recoveries, so the count never exceeds the
    // ceiling (orchestrator.ts reap).
    check(
      'runs_recoveries_check',
      sql`${t.recoveries} >= 0 AND ${t.recoveries} <= ${t.maxRecoveries}`,
    ),
  ],
);

/* ---------------------------------------------------------------------------
 * run_retry_operations — request-level idempotency record for manual retries
 * (p2-38). PK/unique is (project_id, env, source_run_id, operation_key):
 * repeated sends of the SAME retry intent under the same key — a re-send
 * while the request is still pending, a proxy replaying the identical request
 * bytes, the second click of a double-click sharing one key — resolve to the
 * SAME new run, while a different operation key stays a different,
 * independent retry. Dedup holds per caller: each client/dashboard replica
 * mints its own key, so cross-client dedup is a server-coordination concern
 * outside this table. Deliberately NOT the trigger idempotency index
 * (project_id, env, task_id, idempotency_key): a retry operation identifies
 * itself by the SOURCE run, never by the task, so the two key spaces cannot
 * collide. Rows are created only when the caller supplies an operation key —
 * the legacy no-key retry records nothing.
 *
 * Retention follows the runs on both ends (CASCADE): once either the source or
 * the retry run is pruned, the mapping is meaningless — a replayed key would
 * otherwise hand back a dead run id, or answer for a source the retry already
 * 404s on. There is deliberately NO independent TTL or sweeper for this
 * table: the row count is bounded by "explicit retry intents per source run"
 * (each keyed retry is one row; keyless retries record nothing), and each
 * row's life ends exactly with its runs at either end — i.e. the kernel's
 * runs prune (retention, todos/02-performance.md PF6) is the only cleanup
 * this table ever needs. The operation row and its run are inserted in ONE
 * transaction, so no reader can ever observe the row before its retry run
 * exists.
 * ------------------------------------------------------------------------- */
export const runRetryOperations = pgTable(
  'run_retry_operations',
  {
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    sourceRunId: text('source_run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    operationKey: text('operation_key').notNull(),
    /** The new run this operation created (trigger_type='retry'). NOT NULL:
     *  the row is written after its run in the same tx, and CASCADE removes it
     *  with the run — a committed row always answers with a live run id. */
    retryRunId: text('retry_run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.env, t.sourceRunId, t.operationKey] })],
);

/* ---------------------------------------------------------------------------
 * run_steps — composite PK (run_id, seq)
 * ------------------------------------------------------------------------- */
export const runSteps = pgTable(
  'run_steps',
  {
    // FK to runs, ON DELETE CASCADE: retention (todos/02-performance.md PF6)
    // prunes by deleting `runs` rows, and the dependent rows have to follow.
    // Doing it in the database rather than in the prune SQL is what makes
    // "delete a run" mean the same thing everywhere — a manual DELETE in psql
    // can no longer leave a step timeline behind pointing at nothing.
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    kind: text('kind').notNull(),
    label: text('label'),
    /** C1 replay fingerprint: stable hash of kind + label + persistable inputs
     *  + the run's code version, recorded when the row is written and compared
     *  on replay. NULL for rows written before fingerprints existed — the
     *  executor replays those leniently (they cannot be drift-checked). */
    fingerprint: text('fingerprint'),
    status: text('status').notNull(),
    output: jsonb('output'),
    error: jsonb('error'),
    attempt: integer('attempt').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    // C5: kind/status are closed enums (StepKind / StepStatus in
    // @better-trigger/core); the replay executor switches on them.
    check(
      'run_steps_kind_check',
      sql`${t.kind} IN ('step','wait','trigger-and-wait','batch-trigger','now','random','uuid')`,
    ),
    check('run_steps_status_check', sql`${t.status} IN ('completed','failed')`),
    check('run_steps_attempt_check', sql`${t.attempt} >= 1`),
  ],
);

/* ---------------------------------------------------------------------------
 * queue
 * ------------------------------------------------------------------------- */
export const queue = pgTable(
  'queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    // FK to runs, ON DELETE CASCADE (C5): a deleted run takes its queue row
    // with it — the queue row is pure scheduling state for that run and can
    // never outlive it. The unique constraint stays: one queue row per run.
    runId: text('run_id')
      .notNull()
      .unique()
      .references(() => runs.id, { onDelete: 'cascade' }),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    priority: integer('priority').notNull().default(0),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    concurrencyKey: text('concurrency_key'),
  },
  (t) => [
    // Namespace prefix on every index: the claim/reaper/scan loops all filter
    // by (project_id, env) first (C2).
    // Deliberately KEPT though the kernel does not query it today: the
    // concurrency running-count reads runs.concurrency_key, and moving that
    // count onto the queue (where it belongs once claims own the key) will
    // need this exact (project_id, env, concurrency_key) shape. Removing it
    // would be reclaiming bytes on the hottest table at the cost of a forced
    // migration later (p2-29).
    index('queue_concurrency_idx').on(t.projectId, t.env, t.concurrencyKey),
    // Partial, backing the reaper's expired-lease scan every 10s
    // (WHERE lease_until IS NOT NULL AND lease_until <= now() ORDER BY
    // lease_until ASC — todos/02-performance.md PF1). Only claimed rows carry a
    // lease, so the predicate keeps the index to the in-flight subset instead of
    // the whole backlog, and its key order is the scan's ORDER BY.
    index('queue_lease_until_idx')
      .on(t.projectId, t.env, t.leaseUntil)
      .where(sql`${t.leaseUntil} IS NOT NULL`),
    // Partial, backing the claim scan's candidate window — the query every
    // execution slot runs on every poll (WHERE available_at <= now() AND
    // locked_by IS NULL ORDER BY priority DESC, id ASC — todos/02-performance.md
    // PF2). Key order IS that ORDER BY (`nullsFirst` because DESC defaults to
    // NULLS FIRST in Postgres, and an index whose null ordering differs cannot
    // satisfy the sort), so the scan stops at the LIMIT instead of sorting every
    // available row. The predicate is the point: a backlog is mostly *claimed*
    // rows, and they are exactly the ones the scan used to read and throw away.
    // `available_at <= now()` stays a filter — now() is not immutable, so it
    // cannot appear in an index predicate.
    index('queue_claimable_idx')
      .on(t.projectId, t.env, t.priority.desc().nullsFirst(), t.id)
      .where(sql`${t.lockedBy} IS NULL`),
  ],
);

/* ---------------------------------------------------------------------------
 * waits
 * ------------------------------------------------------------------------- */
export const waits = pgTable(
  'waits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    // FK to runs, ON DELETE CASCADE (C5): deleting a run deletes its waits.
    // Safe with prune because prune only deletes TERMINAL runs, and a terminal
    // run's waits are already resolved ('completed'/'canceled') — the row that
    // dies is history, never an outstanding suspension.
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepSeq: integer('step_seq').notNull(),
    kind: text('kind').notNull(),
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    // FK to runs, ON DELETE SET NULL (C5, todos/01-correctness.md): a deleted
    // child run must not strand its parent. CASCADE would delete the parent's
    // wait row outright — the parent stays 'waiting' with no queue row and no
    // wait, i.e. permanently stuck (a manual DELETE of a live child, which
    // prune would never do to a terminal one, is exactly that case). With
    // SET NULL the wait row survives with a NULL child_run_id, and the
    // orchestrator's wait-due scanner recognizes `kind = 'run' AND
    // child_run_id IS NULL AND status = 'pending'` as "the child vanished"
    // and fails the parent (ChildLostError) instead of stranding it. Prune is
    // unaffected: it only deletes TERMINAL children, whose parent waits are
    // already resolved — their stale child_run_id pointers just become NULL.
    childRunId: text('child_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
    /** C1 replay fingerprint computed by the executor when the wait was
     *  created; the resume copies it onto the completed run_steps row so the
     *  parent's replay compares against the DECLARED wait, not a recomputed
     *  absolute instant. */
    fingerprint: text('fingerprint'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('waits_status_resume_idx').on(t.projectId, t.env, t.status, t.resumeAt),
    index('waits_child_run_idx').on(t.projectId, t.env, t.childRunId),
    // Per-run lookups: terminalFail/cancelRun's waits cleanups, waitForChildRun's
    // `run_id + step_seq` probe, and getRunDetail's waits page all hit
    // `WHERE run_id = ...` (waits rows are never deleted, so without this every
    // such query degenerates to a full table scan over time). Namespace prefix
    // first (C2); the step_seq tail covers the child-wait probe.
    index('waits_run_idx').on(t.projectId, t.env, t.runId, t.stepSeq),
    // Pending-step uniqueness (p1-37): a durable step can have AT MOST ONE live
    // wait. Backs waitForChildRun's ON CONFLICT DO NOTHING — a concurrent
    // replay of the same (run, step_seq) loses the insert race and re-reads the
    // winner's wait/step instead of duplicating the parent→child edge.
    // status='pending' is the predicate: completed/canceled rows are history
    // (the step ledger replays those), and a retried step may legitimately
    // re-suspend under a fresh pending row once the old one is resolved.
    uniqueIndex('waits_pending_step_uniq')
      .on(t.projectId, t.env, t.runId, t.stepSeq, t.kind)
      .where(sql`${t.status} = 'pending'`),
    // C5: closed enums (WaitKind / 'pending'|'completed'|'canceled' in core).
    check('waits_kind_check', sql`${t.kind} IN ('duration','until','run')`),
    check('waits_status_check', sql`${t.status} IN ('pending','completed','canceled')`),
  ],
);

/* ---------------------------------------------------------------------------
 * logs
 * ------------------------------------------------------------------------- */
export const logs = pgTable(
  'logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    // Same cascade as run_steps above — logs are the fastest-growing table and
    // the whole reason PF6 exists, so they must not survive their run.
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepSeq: integer('step_seq'),
    level: text('level').notNull(),
    message: text('message').notNull(),
    data: jsonb('data'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('logs_run_id_idx').on(t.projectId, t.env, t.runId, t.id),
    // C5: LogLevel in core — the executor's logger emits exactly these.
    check('logs_level_check', sql`${t.level} IN ('debug','info','warn','error')`),
  ],
);

/* ---------------------------------------------------------------------------
 * schedules — namespace-scoped unique on (project_id, env, task_id): one
 * schedule per task per namespace (C2). The (project_id, env, next_run_at)
 * index backs the cron due-scan, which is namespace-filtered.
 * ------------------------------------------------------------------------- */
export const schedules = pgTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    taskId: text('task_id').notNull(),
    cronPattern: text('cron_pattern').notNull(),
    cronTz: text('cron_tz'),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunId: text('last_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('schedules_task_id_unique').on(t.projectId, t.env, t.taskId),
    index('schedules_next_run_idx').on(t.projectId, t.env, t.nextRunAt),
    // C5: composite FK to the tasks PK (project_id, env, id) — a schedule is
    // one task's cron registration and cannot outlive its task. CASCADE is
    // safe because nothing currently deletes task rows (registration only
    // upserts), and syncSchedules inserts the task and its schedule in the
    // same transaction, so a schedule can never be created without its task.
    foreignKey({
      columns: [t.projectId, t.env, t.taskId],
      foreignColumns: [tasks.projectId, tasks.env, tasks.id],
    }).onDelete('cascade'),
  ],
);

/* ---------------------------------------------------------------------------
 * workers — one row per worker process (globally unique id); the namespaces
 * jsonb column declares which namespaces the worker serves
 * ([{projectId, env}, ...]). Task manifests live in the tasks jsonb.
 * ------------------------------------------------------------------------- */
export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  env: text('env').notNull().default('prod'),
  name: text('name'),
  codeVersion: text('code_version').notNull(),
  runtime: text('runtime').notNull(),
  tasks: jsonb('tasks').notNull(),
  /** Namespaces this worker claims runs from, e.g. [{"projectId":"default","env":"prod"}]. */
  namespaces: jsonb('namespaces')
    .notNull()
    .default(sql`'[{"projectId":"default","env":"prod"}]'::jsonb`),
  concurrency: integer('concurrency').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('online'),
},
// C5: the offline marker and heartbeat loop flip between exactly these two.
(t) => [check('workers_status_check', sql`${t.status} IN ('online','offline')`)],
);

export type DbRun = typeof runs.$inferSelect;
export type DbRunInsert = typeof runs.$inferInsert;
export type DbRunStep = typeof runSteps.$inferSelect;
export type DbRunRetryOperation = typeof runRetryOperations.$inferSelect;
export type DbQueue = typeof queue.$inferSelect;
export type DbWait = typeof waits.$inferSelect;
export type DbSchedule = typeof schedules.$inferSelect;
export type DbWorker = typeof workers.$inferSelect;
export type DbTask = typeof tasks.$inferSelect;
