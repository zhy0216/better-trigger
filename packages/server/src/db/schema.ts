/* =============================================================================
   @better-trigger/server — Drizzle table definitions.
   Authoritative source: docs/backend-contract.md §2 (+ §3.5 concurrency_key on runs).
   All business tables carry project_id ('default') and env ('prod').
   DB columns are snake_case; the JS object keys are camelCase.
   ============================================================================= */
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // NOTE: the partial UNIQUE (task_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    // is created in migrate.ts (raw idempotent SQL). We keep query-level indexes here.
    byTaskCreated: index('runs_task_created_idx').on(t.taskId, t.createdAt),
    byStatusConcurrency: index('runs_status_concurrency_idx').on(t.status, t.concurrencyKey),
    byCreated: index('runs_created_idx').on(t.createdAt),
  }),
);

/* ---------------------------------------------------------------------------
 * run_steps — composite PK (run_id, seq)
 * ------------------------------------------------------------------------- */
export const runSteps = pgTable(
  'run_steps',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    projectId: text('project_id').notNull().default('default'),
    env: text('env').notNull().default('prod'),
    kind: text('kind').notNull(),
    label: text('label'),
    status: text('status').notNull(),
    output: jsonb('output'),
    error: jsonb('error'),
    attempt: integer('attempt').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.seq] }),
  }),
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
    concurrencyKey: text('concurrency_key'),
  },
  (t) => ({
    byAvailable: index('queue_available_priority_idx').on(t.availableAt, t.priority),
    byConcurrency: index('queue_concurrency_idx').on(t.concurrencyKey),
  }),
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
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatusResume: index('waits_status_resume_idx').on(t.status, t.resumeAt),
    byChildRun: index('waits_child_run_idx').on(t.childRunId),
  }),
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
    runId: text('run_id').notNull(),
    stepSeq: integer('step_seq'),
    level: text('level').notNull(),
    message: text('message').notNull(),
    data: jsonb('data'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRun: index('logs_run_id_idx').on(t.runId, t.id),
  }),
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
