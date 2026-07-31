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
     2. the migration is applied to a database that already contains ORPHANS —
        logs and run_steps pointing at a run that no longer exists. That is the
        case that would otherwise fail `ADD CONSTRAINT ... FOREIGN KEY` and,
        because daemons auto-migrate at boot, stop every daemon on that database
        from starting. The orphans are inserted before the constraint exists (a
        pre-0007 schema, rebuilt here by dropping the two constraints) and the
        migration is then re-run;
     3. the real CLI: `better-trigger-worker prune --older-than <w> --dry-run`
        reports rows and deletes nothing; without --dry-run it deletes exactly
        the terminal runs past the window, their cascaded rows, and the offline
        worker rows — while leaving a running run, a fresh terminal run and an
        online worker untouched.

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_RETENTION_DB   override the provisioned database name (default
                       better_trigger_retention)
   ============================================================================= */
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

  /* -- 2. the migration survives a database full of orphans ---------------- */
  await s.check('0007 cleans orphans before adding the constraints', async () => {
    // Rebuild the pre-0007 shape, then create exactly the rows that would make
    // ADD CONSTRAINT fail — and with it every daemon's boot.
    await s.pool.query(`ALTER TABLE logs DROP CONSTRAINT logs_run_id_runs_id_fk`);
    await s.pool.query(`ALTER TABLE run_steps DROP CONSTRAINT run_steps_run_id_runs_id_fk`);
    await s.pool.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE hash IN (
         SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1)`,
    );
    await s.pool.query(
      `INSERT INTO logs (run_id, level, message) VALUES ('run_gone', 'info', 'orphan')`,
    );
    await s.pool.query(
      `INSERT INTO run_steps (run_id, seq, kind, status)
       VALUES ('run_gone', 1, 'step', 'completed')`,
    );

    // This is the assertion: it must not throw.
    await migrate(s.pool);

    s.assertEqual(
      await count(s, `SELECT count(*) FROM logs WHERE run_id = 'run_gone'`),
      0,
      'orphaned logs after the migration',
    );
    s.assertEqual(
      await count(s, `SELECT count(*) FROM run_steps WHERE run_id = 'run_gone'`),
      0,
      'orphaned run_steps after the migration',
    );
    // And the constraints are back, so the cascade still applies.
    s.assertEqual(
      await count(
        s,
        `SELECT count(*) FROM pg_constraint
          WHERE conname IN ('logs_run_id_runs_id_fk','run_steps_run_id_runs_id_fk')`,
      ),
      2,
      'foreign keys after the re-run migration',
    );
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

  s.cleanup(() => s.db.drop());
}

void runScenario(
  {
    name: 'retention',
    what: 'pruning deletes history through the foreign-key cascade',
    db: { name: 'better_trigger_retention', envVar: 'BT_RETENTION_DB' },
  },
  main,
);
