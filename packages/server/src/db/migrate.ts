/* =============================================================================
   @better-trigger/server — startup migration.
   We DO NOT use drizzle-kit. Instead we run hand-written, fully idempotent SQL
   (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) that mirrors
   schema.ts exactly. Safe to run on every boot.
   ============================================================================= */
import { pool } from './index';

const MIGRATION_SQL = /* sql */ `
-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id                  text PRIMARY KEY,
  project_id          text NOT NULL DEFAULT 'default',
  env                 text NOT NULL DEFAULT 'prod',
  name                text NOT NULL,
  file_path           text,
  trigger_source      text NOT NULL DEFAULT 'api',
  cron_pattern        text,
  cron_tz             text,
  retry               jsonb,
  concurrency_limit   integer,
  latest_code_version text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id              text PRIMARY KEY,
  project_id      text NOT NULL DEFAULT 'default',
  env             text NOT NULL DEFAULT 'prod',
  task_id         text NOT NULL,
  status          text NOT NULL,
  payload         jsonb,
  output          jsonb,
  error           jsonb,
  trigger_type    text NOT NULL,
  parent_run_id   text,
  code_version    text,
  idempotency_key text,
  concurrency_key text,
  attempt         integer NOT NULL DEFAULT 1,
  max_attempts    integer NOT NULL DEFAULT 1,
  queued_at       timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_task_idempotency_uniq
  ON runs (task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_task_created_idx ON runs (task_id, created_at);
CREATE INDEX IF NOT EXISTS runs_status_concurrency_idx ON runs (status, concurrency_key);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at);

-- ---------------------------------------------------------------------------
-- run_steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_steps (
  run_id      text NOT NULL,
  seq         integer NOT NULL,
  project_id  text NOT NULL DEFAULT 'default',
  env         text NOT NULL DEFAULT 'prod',
  kind        text NOT NULL,
  label       text,
  status      text NOT NULL,
  output      jsonb,
  error       jsonb,
  attempt     integer NOT NULL DEFAULT 1,
  started_at  timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, seq)
);

-- ---------------------------------------------------------------------------
-- queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queue (
  id              bigserial PRIMARY KEY,
  project_id      text NOT NULL DEFAULT 'default',
  env             text NOT NULL DEFAULT 'prod',
  run_id          text NOT NULL UNIQUE,
  available_at    timestamptz NOT NULL DEFAULT now(),
  priority        integer NOT NULL DEFAULT 0,
  locked_by       text,
  locked_at       timestamptz,
  concurrency_key text
);

CREATE INDEX IF NOT EXISTS queue_available_priority_idx ON queue (available_at, priority DESC);
CREATE INDEX IF NOT EXISTS queue_concurrency_idx ON queue (concurrency_key);

-- ---------------------------------------------------------------------------
-- waits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waits (
  id           bigserial PRIMARY KEY,
  project_id   text NOT NULL DEFAULT 'default',
  env          text NOT NULL DEFAULT 'prod',
  run_id       text NOT NULL,
  step_seq     integer NOT NULL,
  kind         text NOT NULL,
  resume_at    timestamptz,
  child_run_id text,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waits_status_resume_idx ON waits (status, resume_at);
CREATE INDEX IF NOT EXISTS waits_child_run_idx ON waits (child_run_id);

-- ---------------------------------------------------------------------------
-- logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logs (
  id         bigserial PRIMARY KEY,
  project_id text NOT NULL DEFAULT 'default',
  env        text NOT NULL DEFAULT 'prod',
  run_id     text NOT NULL,
  step_seq   integer,
  level      text NOT NULL,
  message    text NOT NULL,
  data       jsonb,
  ts         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS logs_run_id_idx ON logs (run_id, id);

-- ---------------------------------------------------------------------------
-- schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
  id           text PRIMARY KEY,
  project_id   text NOT NULL DEFAULT 'default',
  env          text NOT NULL DEFAULT 'prod',
  task_id      text NOT NULL UNIQUE,
  cron_pattern text NOT NULL,
  cron_tz      text,
  enabled      boolean NOT NULL DEFAULT true,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_run_id  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- workers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workers (
  id                text PRIMARY KEY,
  project_id        text NOT NULL DEFAULT 'default',
  env               text NOT NULL DEFAULT 'prod',
  name              text,
  code_version      text NOT NULL,
  runtime           text NOT NULL,
  tasks             jsonb NOT NULL,
  concurrency       integer NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'online'
);
`;

/** Run idempotent DDL. Called once at server boot before listening. */
export async function migrate(): Promise<void> {
  await pool.query(MIGRATION_SQL);
}
