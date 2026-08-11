/* =============================================================================
   @better-trigger/example-basic — migration upgrade + downgrade-compat scenario
   (O5, todos/03-operability.md).

   Daemons auto-migrate at boot, so "the migration history applies cleanly to
   a database that already has data" is a boot-safety property: an upgrade
   that breaks existing rows stops every daemon on that database from
   starting. The migrations are forward-only (drizzle-kit generate), so the
   honest downgrade story is: a deploy rollback keeps the NEW schema while the
   OLD binary keeps running — which works exactly when every old-version
   table/column is still present and old-shape writes still succeed. Both are
   proven here on a real Postgres:

   UPGRADE (0007 → latest):
     1. apply migrations 0000..0007 by hand (executing the same .sql files
        drizzle runs, journaling the same sha256 hashes drizzle computes), so
        the database is in exactly the state a daemon from that era would
        have left it;
     2. seed old-version data (task, run, step, log, queue row, wait row,
        schedule) using only columns that existed then;
     3. run the real `migrate()` — it must apply 0008..0011 and skip the
        already-journaled 0000..0007;
     4. the seeded rows survive with their values, the journal holds all 12
        migrations, and the constraints the new migrations added actually
        fire (23514 status/level CHECKs, 23503 FK refusals).

   DOWNGRADE-COMPAT (old binary on the new schema):
     5. every table+column that existed at 0007 still exists at latest — the
        additive property a rolled-back binary depends on;
     6. old-shape INSERTs against every table (tasks, runs, queue, waits,
        logs, schedules — 0007-era column sets only) still succeed and read
        back, so the old binary's writes keep working on the new schema;
     7. re-running `migrate()` is a no-op (the journal is consistent, so a
        rolled-back daemon booting again cannot wedge on re-migration).

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_MIGRATE_DB     override the provisioned database name (default
                       better_trigger_migrate)
   ============================================================================= */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from '@better-trigger/db';
import { runScenario, type Scenario } from '@better-trigger/testing';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../packages/db/migrations', import.meta.url),
);

/** Migrations applied by hand before the real `migrate()` takes over. */
const OLD_ERA_LAST = '0007_aberrant_the_liberteens.sql';

interface Column {
  table_name: string;
  column_name: string;
}

async function columnInventory(s: Scenario): Promise<Column[]> {
  const res = await s.pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' ORDER BY table_name, column_name`,
  );
  return res.rows as Column[];
}

/**
 * Apply the migration .sql files up to (and including) `untilFile`, exactly
 * the way drizzle's migrator would: each file split on the statement-
 * breakpoint marker, each statement executed in order, and the journal row
 * carrying the sha256 of the whole file content AND the folderMillis
 * (`when`) of the journal entry. The folderMillis is what drizzle's migrator
 * actually compares (newest applied row's created_at vs. each entry's `when`),
 * so the hand-applied era is skipped and never re-run — the hash alone is
 * journal metadata, not the skip decision.
 */
async function applyUpTo(s: Scenario, untilFile: string): Promise<void> {
  const journal = JSON.parse(
    readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8'),
  ) as { entries: Array<{ tag: string; when: number }> };
  const whenByTag = new Map(journal.entries.map((e) => [e.tag, e.when]));

  await s.pool.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await s.pool.query(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
       "id" serial PRIMARY KEY,
       "hash" text NOT NULL,
       "created_at" bigint
     )`,
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await s.pool.query(trimmed);
    }
    const when = whenByTag.get(file.replace(/\.sql$/, ''));
    if (when === undefined) throw new Error(`no journal entry for ${file}`);
    await s.pool.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      [createHash('sha256').update(sql).digest('hex'), when],
    );
    if (file === untilFile) break;
  }
}

const count = async (s: Scenario, sql: string, params: unknown[] = []): Promise<number> => {
  const res = await s.pool.query<{ count: string }>(sql, params);
  return Number(res.rows[0]?.count ?? 0);
};

/** Seed data shaped by the 0007-era schema (all columns exist since 0000). */
async function seedOldEra(s: Scenario): Promise<void> {
  await s.pool.query(
    `INSERT INTO tasks (id, name) VALUES ('mig-task', 'mig-task')`,
  );
  await s.pool.query(
    `INSERT INTO runs (id, task_id, status, trigger_type, payload, created_at, updated_at)
     VALUES ('run_old', 'mig-task', 'completed', 'api', '{"user":"u_7"}'::jsonb, now(), now())`,
  );
  await s.pool.query(
    `INSERT INTO run_steps (run_id, seq, kind, label, status, attempt)
     VALUES ('run_old', 0, 'step', 'load', 'completed', 1)`,
  );
  await s.pool.query(
    `INSERT INTO logs (run_id, level, message, ts)
     VALUES ('run_old', 'info', 'seeded before upgrade', now())`,
  );
  await s.pool.query(
    `INSERT INTO queue (run_id, available_at) VALUES ('run_old', now())`,
  );
  await s.pool.query(
    `INSERT INTO waits (run_id, step_seq, kind, status, resume_at)
     VALUES ('run_old', 1, 'duration', 'pending', now() + interval '1 hour')`,
  );
  await s.pool.query(
    `INSERT INTO schedules (id, task_id, cron_pattern, created_at, updated_at)
     VALUES ('sch_old', 'mig-task', '* * * * *', now(), now())`,
  );
}

async function main(s: Scenario): Promise<void> {
  /* -- UPGRADE --------------------------------------------------------------- */
  let oldColumns: Column[] = [];
  await s.check('0007-era schema can be reconstructed by hand', async () => {
    await applyUpTo(s, OLD_ERA_LAST);
    oldColumns = await columnInventory(s);
    s.assert(
      oldColumns.some((c) => c.table_name === 'runs' && c.column_name === 'payload'),
      'the 0007-era column inventory should include runs.payload',
    );
    s.assert(
      !oldColumns.some((c) => c.table_name === 'workers' && c.column_name === 'namespaces'),
      'the 0007-era schema must predate workers.namespaces (0010)',
    );
  });

  await s.check('old-era data seeds with the upgrade pending', async () => {
    await seedOldEra(s);
    s.assertEqual(await count(s, `SELECT count(*) FROM runs WHERE id = 'run_old'`), 1, 'seeded run');
  });

  await s.check('migrate() upgrades 0007 → latest without touching the data', async () => {
    await migrate(s.pool);

    // Data survives, values intact.
    s.assertEqual(await count(s, `SELECT count(*) FROM tasks WHERE id = 'mig-task'`), 1, 'task');
    const run = await s.pool.query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM runs WHERE id = 'run_old'`,
    );
    s.assertEqual(run.rows[0]?.status, 'completed', 'run status');
    s.assertEqual(run.rows[0]?.payload, { user: 'u_7' }, 'run payload');
    s.assertEqual(await count(s, `SELECT count(*) FROM run_steps WHERE run_id = 'run_old'`), 1, 'step');
    s.assertEqual(await count(s, `SELECT count(*) FROM logs WHERE run_id = 'run_old'`), 1, 'log');
    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = 'run_old'`), 1, 'queue row');
    s.assertEqual(await count(s, `SELECT count(*) FROM waits WHERE run_id = 'run_old'`), 1, 'wait row');
    s.assertEqual(await count(s, `SELECT count(*) FROM schedules WHERE id = 'sch_old'`), 1, 'schedule');

    // The journal holds all 12 migrations — none pending, none re-run.
    s.assertEqual(
      await count(s, `SELECT count(*) FROM "drizzle"."__drizzle_migrations"`),
      12,
      'journal entries after upgrade',
    );
  });

  await s.check('the constraints the upgrade added actually fire', async () => {
    // 23514 = check_violation: the 0011 status/level CHECKs are live.
    await s.pool
      .query(
        `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
         VALUES ('run_bad_status', 'mig-task', 'bogus', 'api', now(), now())`,
      )
      .then(
        () => s.fail('a bogus runs.status must be refused by runs_status_check'),
        (err: { code?: string }) => {
          s.assertEqual(err.code, '23514', 'runs_status_check violation code');
        },
      );
    await s.pool
      .query(
        `INSERT INTO logs (run_id, level, message) VALUES ('run_old', 'scream', 'nope')`,
      )
      .then(
        () => s.fail('an unknown log level must be refused by logs_level_check'),
        (err: { code?: string }) => {
          s.assertEqual(err.code, '23514', 'logs_level_check violation code');
        },
      );
    // 23503 = foreign_key_violation: the 0011 FKs are live.
    await s.pool
      .query(`INSERT INTO queue (run_id, available_at) VALUES ('run_ghost', now())`)
      .then(
        () => s.fail('a queue row for a missing run must be refused'),
        (err: { code?: string }) => {
          s.assertEqual(err.code, '23503', 'queue_run_id FK violation code');
        },
      );
    await s.pool
      .query(`INSERT INTO waits (run_id, step_seq, kind, status) VALUES ('run_ghost', 1, 'duration', 'pending')`)
      .then(
        () => s.fail('a waits row for a missing run must be refused'),
        (err: { code?: string }) => {
          s.assertEqual(err.code, '23503', 'waits_run_id FK violation code');
        },
      );
  });

  /* -- DOWNGRADE-COMPAT ------------------------------------------------------- */
  await s.check('the 0007-era schema is a strict subset of latest (additive migrations)', async () => {
    const latest = await columnInventory(s);
    const latestSet = new Set(latest.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = oldColumns.filter(
      (c) => !latestSet.has(`${c.table_name}.${c.column_name}`),
    );
    s.assert(
      missing.length === 0,
      `downgrade would break: ${missing.map((c) => c.table_name + '.' + c.column_name).join(', ')} no longer exist`,
    );
  });

  /*
   * The downgrade story for a forward-only migration tool is "the OLD binary
   * runs on the NEW schema": the subset check above proves the old shape is
   * still present, and these INSERTs prove the old binary's WRITES still land
   * — one per table, using only the columns that existed at 0007. (Real
   * old-binary compatibility is additionally guaranteed by the C5 design: the
   * constraints the upgrade added are supersets of the values the engine has
   * always written, so an old binary's legal writes can never violate them.)
   */
  await s.check('old-shape writes still succeed on the new schema (all five tables)', async () => {
    // tasks — the 0007-era column set is (id, name): the rest had defaults.
    await s.pool.query(`INSERT INTO tasks (id, name) VALUES ('mig-task-2', 'mig-task-2')`);
    // runs — the exact columns an 0007-era binary would INSERT with.
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
       VALUES ('run_old_shape', 'mig-task-2', 'failed', 'api', now(), now())`,
    );
    // queue / waits / logs — derived rows written with the old column sets
    // (the FKs 0011 added reference the run above and pass).
    await s.pool.query(
      `INSERT INTO queue (run_id, available_at) VALUES ('run_old_shape', now())`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, status, resume_at)
       VALUES ('run_old_shape', 1, 'duration', 'pending', now() + interval '1 hour')`,
    );
    await s.pool.query(
      `INSERT INTO logs (run_id, level, message, ts)
       VALUES ('run_old_shape', 'info', 'written by an old binary', now())`,
    );
    // schedules — old shape (id, task_id, cron_pattern, created_at, updated_at);
    // the schedules→tasks FK 0011 added passes against the task above.
    await s.pool.query(
      `INSERT INTO schedules (id, task_id, cron_pattern, created_at, updated_at)
       VALUES ('sch_old_shape', 'mig-task-2', '* * * * *', now(), now())`,
    );

    // Every old-shape write reads back.
    s.assertEqual(await count(s, `SELECT count(*) FROM tasks WHERE id = 'mig-task-2'`), 1, 'old-shape task');
    const run = await s.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = 'run_old_shape'`,
    );
    s.assertEqual(run.rows[0]?.status, 'failed', 'old-shape run readable after upgrade');
    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = 'run_old_shape'`), 1, 'old-shape queue row');
    s.assertEqual(await count(s, `SELECT count(*) FROM waits WHERE run_id = 'run_old_shape'`), 1, 'old-shape wait row');
    s.assertEqual(await count(s, `SELECT count(*) FROM logs WHERE run_id = 'run_old_shape'`), 1, 'old-shape log row');
    s.assertEqual(await count(s, `SELECT count(*) FROM schedules WHERE id = 'sch_old_shape'`), 1, 'old-shape schedule');
  });

  await s.check('re-running migrate() is a no-op (rolled-back daemon cannot wedge)', async () => {
    await migrate(s.pool);
    s.assertEqual(
      await count(s, `SELECT count(*) FROM "drizzle"."__drizzle_migrations"`),
      12,
      'journal unchanged by the second migrate',
    );
  });
}

await runScenario(
  {
    name: 'migration',
    what: '0007→latest upgrade preserves data and fires new constraints; the old schema stays a subset',
    // The whole point is exercising the upgrade path from a hand-built
    // 0007-era schema, so resetDb must NOT migrate to latest first.
    db: { name: 'better_trigger_migrate', envVar: 'BT_MIGRATE_DB', migrate: false },
  },
  main,
);
