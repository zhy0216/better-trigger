/* =============================================================================
   @better-trigger/example-basic — data retention e2e (todos/02-performance.md
   PF6).

   The unit tests around prune() read the SQL it issues; they cannot tell
   whether Postgres actually honours the part that is NOT in that SQL — the
   `ON DELETE CASCADE` added by migration 0007, which is the entire reason
   pruning a run is one DELETE instead of four. This scenario proves it on a
   real database:

     1. a plain `DELETE FROM runs` takes that run's run_steps and logs with it,
        and leaves every other run's rows alone (the cascade exists, and is
        scoped to the run);
     2. the migration history is applied to a database that already contains
        ORPHANS — queue / waits / schedules rows pointing at runs or tasks
        that no longer exist, and a parent_run_id pointing at nothing. That is
        the case that would otherwise fail `ADD CONSTRAINT ... FOREIGN KEY`
        and, because daemons auto-migrate at boot, stop every daemon on that
        database from starting. The orphans are inserted before the
        constraints exist (the 0011 constraints are dropped, i.e. a
        pre-retention schema, rebuilt here) and the 0011 migration is then
        re-run;
     3. the real CLI: `better-trigger-worker prune --older-than <w> --dry-run`
        reports rows and deletes nothing; without --dry-run it deletes exactly
        the terminal runs past the window, their cascaded rows, and the offline
        worker rows — while leaving a running run, a fresh terminal run and an
        online worker untouched.

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_RETENTION_DB   override the database name prefix (default
                       better_trigger_retention)
   ============================================================================= */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrate } from '@better-trigger/db';
import { runScenario, type Scenario } from '@better-trigger/testing';

/** apps/worker's entry, run from source — same resolution as spawnDaemon. */
const WORKER_ENTRY =
  process.env.BT_WORKER_ENTRY ??
  fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));

const DAY = 86_400_000;

interface CliRun {
  code: number | null;
  stdout: string;
}

/** Run the real CLI against this scenario's database and capture its report. */
function prune(databaseUrl: string, args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [WORKER_ENTRY, 'prune', ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (b) => (stdout += String(b)));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

/** One run plus one step and two log lines, at a chosen age. */
async function seedRun(
  s: Scenario,
  id: string,
  status: string,
  finishedDaysAgo: number | null,
): Promise<void> {
  const finished =
    finishedDaysAgo === null ? null : new Date(Date.now() - finishedDaysAgo * DAY);
  await s.pool.query(
    `INSERT INTO runs (id, task_id, status, trigger_type, finished_at, created_at, updated_at)
     VALUES ($1, 'retention-demo', $2, 'api', $3, now(), COALESCE($3, now()))`,
    [id, status, finished],
  );
  await s.pool.query(
    `INSERT INTO run_steps (run_id, seq, kind, status) VALUES ($1, 1, 'step', 'completed')`,
    [id],
  );
  await s.pool.query(
    `INSERT INTO logs (run_id, level, message) VALUES ($1, 'info', 'a'), ($1, 'info', 'b')`,
    [id],
  );
}

const count = async (s: Scenario, sql: string, params: unknown[] = []): Promise<number> => {
  const res = await s.pool.query<{ count: string }>(sql, params);
  return Number(res.rows[0]?.count ?? 0);
};

async function main(s: Scenario): Promise<void> {
  /* -- 1. the cascade is real ---------------------------------------------- */
  await seedRun(s, 'run_cascade', 'completed', 40);
  await seedRun(s, 'run_keep', 'completed', 40);

  await s.check('DELETE FROM runs cascades to run_steps and logs', async () => {
    await s.pool.query(`DELETE FROM runs WHERE id = 'run_cascade'`);
    s.assertEqual(
      await count(s, `SELECT count(*) FROM run_steps WHERE run_id = 'run_cascade'`),
      0,
      'run_steps of the deleted run',
    );
    s.assertEqual(
      await count(s, `SELECT count(*) FROM logs WHERE run_id = 'run_cascade'`),
      0,
      'logs of the deleted run',
    );
    // Scoped: the cascade must take that run's rows, not the table.
    s.assertEqual(
      await count(s, `SELECT count(*) FROM logs WHERE run_id = 'run_keep'`),
      2,
      'logs of the surviving run',
    );
  });

  /* -- 2. the migration history survives a database full of orphans -------- */
  await s.check('0011 cleans orphans before adding the constraints', async () => {
    // Rebuild the pre-0011 shape: drop every FK/CHECK 0011 adds (plus 0016's
    // two CHECKs), undo the schema effects of everything younger, and
    // de-journal 0011..0016, so `migrate()` re-applies them — orphan cleanups
    // included. (Journal records are identified by their hash, which is
    // sha256(sql file content), computed exactly as drizzle's migrator does.
    // Only 0011 and younger re-run: the migrator skips everything older than
    // the newest remaining record, so 0007..0010 stay applied as-is.)
    const C5_CONSTRAINTS: Array<{ table: string; name: string }> = [
      { table: 'queue', name: 'queue_run_id_runs_id_fk' },
      { table: 'runs', name: 'runs_parent_run_id_runs_id_fk' },
      { table: 'schedules', name: 'schedules_project_id_env_task_id_tasks_project_id_env_id_fk' },
      { table: 'waits', name: 'waits_run_id_runs_id_fk' },
      { table: 'waits', name: 'waits_child_run_id_runs_id_fk' },
      { table: 'logs', name: 'logs_level_check' },
      { table: 'run_steps', name: 'run_steps_kind_check' },
      { table: 'run_steps', name: 'run_steps_status_check' },
      { table: 'run_steps', name: 'run_steps_attempt_check' },
      { table: 'runs', name: 'runs_status_check' },
      { table: 'runs', name: 'runs_attempt_check' },
      { table: 'runs', name: 'runs_recoveries_check' },
      { table: 'waits', name: 'waits_kind_check' },
      { table: 'waits', name: 'waits_status_check' },
      { table: 'workers', name: 'workers_status_check' },
      // 0016's two CHECKs: dropped with the rest so the re-migrate re-applies
      // them instead of failing on a duplicate_object.
      { table: 'runs', name: 'runs_trigger_type_check' },
      { table: 'tasks', name: 'tasks_trigger_source_check' },
    ];
    for (const c of C5_CONSTRAINTS) {
      await s.pool.query(`ALTER TABLE ${c.table} DROP CONSTRAINT ${c.name}`);
    }

    const migrationsDir = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
    // Re-running 0011 means making it (and everything younger) the newest
    // migration again: de-journal 0011..0016 and undo their schema effects so
    // the re-migrate re-applies them cleanly — 0012's CREATE INDEX needs
    // waits_run_idx gone, 0013's DROP INDEX needs queue_available_priority_idx
    // to exist first (it is the pre-0013 shape the fixture rebuilds), and
    // 0014/0015's unique index and retry-operations table must go or their
    // CREATE statements fail on the re-migrate. 0016's four FK-support indexes
    // on tables this fixture keeps have the same problem (its two on
    // run_retry_operations go with that table), while its logs_run_id_idx
    // rebuild needs no undo because 0016 opens with a DROP. (The migrator skips
    // everything at or below the newest remaining journal row's created_at, so
    // leaving ANY of 0012..0016 journaled would silently skip 0011's cleanups
    // as well.)
    await s.pool.query(`DROP INDEX IF EXISTS waits_run_idx`);
    await s.pool.query(`DROP INDEX IF EXISTS waits_pending_step_uniq`);
    await s.pool.query(`DROP INDEX IF EXISTS waits_run_id_fk_idx`);
    await s.pool.query(`DROP INDEX IF EXISTS waits_child_run_id_fk_idx`);
    await s.pool.query(`DROP INDEX IF EXISTS runs_parent_run_id_fk_idx`);
    await s.pool.query(`DROP INDEX IF EXISTS workers_online_heartbeat_idx`);
    await s.pool.query(`DROP TABLE IF EXISTS run_retry_operations`);
    await s.pool.query(
      `CREATE INDEX "queue_available_priority_idx" ON "queue"
         USING btree ("project_id", "env", "available_at", "priority" DESC NULLS LAST)`,
    );
    for (const file of [
      '0011_thick_rage.sql',
      '0012_massive_punisher.sql',
      '0013_cool_nomad.sql',
      '0014_cooing_miek.sql',
      '0015_cynical_millenium_guard.sql',
      '0016_smooth_loki.sql',
    ]) {
      const sql = readFileSync(`${migrationsDir}/${file}`, 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      await s.pool.query(`DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1`, [hash]);
    }

    // Orphans that would make ADD CONSTRAINT fail — and with it every
    // daemon's boot. (logs / run_steps orphans are the 0007 cleanup's job and
    // were proven when that migration was the newest; 0011's own orphans are
    // the ones under test here.)
    await s.pool.query(`INSERT INTO queue (run_id, available_at) VALUES ('run_gone', now())`);
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, status)
       VALUES ('run_gone', 1, 'duration', 'pending')`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, child_run_id, status)
       VALUES ('run_waiter', 1, 'run', 'run_gone', 'pending')`,
    );
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, parent_run_id, created_at, updated_at)
       VALUES ('run_orphan_parent', 't', 'queued', 'api', 'run_gone', now(), now())`,
    );
    await s.pool.query(
      `INSERT INTO schedules (id, task_id, cron_pattern, created_at, updated_at)
       VALUES ('sch_orphan', 'task_gone', '* * * * *', now(), now())`,
    );

    // This is the assertion: it must not throw.
    await migrate(s.pool);

    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = 'run_gone'`), 0, 'orphaned queue rows');
    s.assertEqual(await count(s, `SELECT count(*) FROM waits WHERE run_id = 'run_gone'`), 0, 'orphaned waits (run_id)');
    s.assertEqual(
      await count(s, `SELECT count(*) FROM waits WHERE child_run_id = 'run_gone'`),
      0,
      'orphaned waits (child_run_id)',
    );
    const parent = await s.pool.query<{ parent_run_id: string | null }>(
      `SELECT parent_run_id FROM runs WHERE id = 'run_orphan_parent'`,
    );
    s.assertEqual(parent.rows[0]?.parent_run_id, null, 'orphaned parent_run_id set to NULL');
    s.assertEqual(await count(s, `SELECT count(*) FROM schedules WHERE id = 'sch_orphan'`), 0, 'orphaned schedules');
    // And the constraints are back, so the cascades still apply.
    s.assertEqual(
      await count(
        s,
        `SELECT count(*) FROM pg_constraint WHERE conname = ANY($1::text[])`,
        [C5_CONSTRAINTS.map((c) => c.name)],
      ),
      C5_CONSTRAINTS.length,
      'constraints after the re-run migration',
    );

    // The orphan scaffolding is the check's, not the database's: it was only
    // there to make ADD CONSTRAINT fail, so take it away before the CLI test
    // below counts what a prune would remove.
    await s.pool.query(`DELETE FROM runs WHERE id IN ('run_orphan_parent','run_waiter')`);
  });

  /* -- 3. the CLI ---------------------------------------------------------- */
  await seedRun(s, 'run_old_failed', 'failed', 40);
  await seedRun(s, 'run_old_canceled', 'canceled', 40);
  await seedRun(s, 'run_fresh', 'completed', 1);
  await seedRun(s, 'run_stuck', 'running', null);
  // A stuck run is old by every measure except the one that counts.
  await s.pool.query(
    `UPDATE runs SET created_at = now() - interval '90 days',
                     updated_at = now() - interval '90 days'
      WHERE id = 'run_stuck'`,
  );
  await s.pool.query(
    `INSERT INTO workers (id, code_version, runtime, tasks, concurrency, started_at,
                          last_heartbeat_at, status)
     VALUES ('wrk_old', 'v1', 'bun', '[]'::jsonb, 1, now() - interval '40 days',
             now() - interval '40 days', 'offline'),
            ('wrk_live', 'v1', 'bun', '[]'::jsonb, 1, now(), now(), 'online')`,
  );

  const runsBefore = await count(s, `SELECT count(*) FROM runs`);
  const logsBefore = await count(s, `SELECT count(*) FROM logs`);

  await s.check('prune --dry-run reports and deletes nothing', async () => {
    const run = await prune(s.db.url, ['--older-than', '30d', '--dry-run', '--no-migrate']);
    s.assertEqual(run.code, 0, 'prune --dry-run exit code');
    s.assert(/\[dry-run\] would delete: 3 run\(s\)/.test(run.stdout), run.stdout);
    s.assert(/6 log\(s\)/.test(run.stdout), run.stdout);
    s.assert(/1 worker row\(s\)/.test(run.stdout), run.stdout);
    s.assertEqual(await count(s, `SELECT count(*) FROM runs`), runsBefore, 'runs after dry run');
    s.assertEqual(await count(s, `SELECT count(*) FROM logs`), logsBefore, 'logs after dry run');
    s.assertEqual(await count(s, `SELECT count(*) FROM workers`), 2, 'workers after dry run');
  });

  await s.check('prune deletes the terminal history past the window', async () => {
    const run = await prune(s.db.url, ['--older-than', '30d', '--no-migrate']);
    s.assertEqual(run.code, 0, 'prune exit code');
    s.assert(/deleted: 3 run\(s\)/.test(run.stdout), run.stdout);

    const left = await s.pool.query<{ id: string }>(`SELECT id FROM runs ORDER BY id`);
    s.assertEqual(
      left.rows.map((r) => r.id),
      ['run_fresh', 'run_stuck'],
      'surviving runs',
    );
    // The cascade did the dependent tables — prune never names them.
    s.assertEqual(await count(s, `SELECT count(*) FROM logs`), 4, 'surviving logs');
    s.assertEqual(await count(s, `SELECT count(*) FROM run_steps`), 2, 'surviving steps');
    // Offline and past the window goes; the live one stays whatever its age.
    const workers = await s.pool.query<{ id: string }>(`SELECT id FROM workers`);
    s.assertEqual(
      workers.rows.map((w) => w.id),
      ['wrk_live'],
      'surviving workers',
    );
  });

  await s.check('a second prune is a no-op', async () => {
    const run = await prune(s.db.url, ['--older-than', '30d', '--no-migrate']);
    s.assertEqual(run.code, 0, 'prune exit code');
    s.assert(/deleted: 0 run\(s\)/.test(run.stdout), run.stdout);
  });
}

void runScenario(
  {
    name: 'retention',
    what: 'pruning deletes history through the foreign-key cascade',
    db: { name: 'better_trigger_retention', envVar: 'BT_RETENTION_DB' },
  },
  main,
);
