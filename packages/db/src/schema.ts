/* =============================================================================
   @better-trigger/db — Drizzle table definitions.
   SINGLE SOURCE OF TRUTH for the database shape: migrations are generated from
   this file via `bun run db:generate` (drizzle-kit) into ../migrations.
   Authoritative spec: docs/backend-contract.md §2 (+ §3.5 concurrency_key on runs).
   All business tables carry project_id ('default') and env ('prod').
   DB columns are snake_case; the JS object keys are camelCase.
   ============================================================================= */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ---------------------------------------------------------------------------
 * tasks
 * ------------------------------------------------------------------------- */
export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
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
});

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
    parentRunId: text('parent_run_id'),
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
    // (ON CONFLICT (task_id, idempotency_key) WHERE idempotency_key IS NOT NULL).
    uniqueIndex('runs_task_idempotency_uniq')
      .on(t.taskId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('runs_task_created_idx').on(t.taskId, t.createdAt),
    index('runs_status_concurrency_idx').on(t.status, t.concurrencyKey),
    index('runs_created_idx').on(t.createdAt),
  ],
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
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
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
    runId: text('run_id').notNull().unique(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    priority: integer('priority').notNull().default(0),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    concurrencyKey: text('concurrency_key'),
  },
  (t) => [
    index('queue_available_priority_idx').on(t.availableAt, t.priority.desc()),
    index('queue_concurrency_idx').on(t.concurrencyKey),
    // Partial, backing the reaper's expired-lease scan every 10s
    // (WHERE lease_until IS NOT NULL AND lease_until <= now() ORDER BY
    // lease_until ASC — todos/02-performance.md PF1). Only claimed rows carry a
    // lease, so the predicate keeps the index to the in-flight subset instead of
    // the whole backlog, and its key order is the scan's ORDER BY.
    index('queue_lease_until_idx')
      .on(t.leaseUntil)
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
      .on(t.priority.desc().nullsFirst(), t.id)
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
    runId: text('run_id').notNull(),
    stepSeq: integer('step_seq').notNull(),
    kind: text('kind').notNull(),
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    childRunId: text('child_run_id'),
    /** C1 replay fingerprint computed by the executor when the wait was
     *  created; the resume copies it onto the completed run_steps row so the
     *  parent's replay compares against the DECLARED wait, not a recomputed
     *  absolute instant. */
    fingerprint: text('fingerprint'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('waits_status_resume_idx').on(t.status, t.resumeAt),
    index('waits_child_run_idx').on(t.childRunId),
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
  (t) => [index('logs_run_id_idx').on(t.runId, t.id)],
);

/* ---------------------------------------------------------------------------
 * schedules
 * ------------------------------------------------------------------------- */
export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  env: text('env').notNull().default('prod'),
  taskId: text('task_id').notNull().unique(),
  cronPattern: text('cron_pattern').notNull(),
  cronTz: text('cron_tz'),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastRunId: text('last_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------------------------------------------------------------------
 * workers
 * ------------------------------------------------------------------------- */
export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  env: text('env').notNull().default('prod'),
  name: text('name'),
  codeVersion: text('code_version').notNull(),
  runtime: text('runtime').notNull(),
  tasks: jsonb('tasks').notNull(),
  concurrency: integer('concurrency').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('online'),
});

export type DbRun = typeof runs.$inferSelect;
export type DbRunInsert = typeof runs.$inferInsert;
export type DbRunStep = typeof runSteps.$inferSelect;
export type DbQueue = typeof queue.$inferSelect;
export type DbWait = typeof waits.$inferSelect;
export type DbSchedule = typeof schedules.$inferSelect;
export type DbWorker = typeof workers.$inferSelect;
export type DbTask = typeof tasks.$inferSelect;
