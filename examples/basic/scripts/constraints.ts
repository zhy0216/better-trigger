/* =============================================================================
   @better-trigger/example-basic — database-level constraints e2e
   (todos/01-correctness.md C5).

   The unit tests around the constraints read the shipped migration SQL; they
   cannot tell whether Postgres actually enforces any of it. This scenario
   proves it on a real database:

     1. the five foreign keys and twelve CHECK constraints exist (pg_constraint;
        ten from 0011, the two trigger enums from 0016);
     2. a manual `DELETE FROM runs` takes the run's queue row and its own
        waits, and SET NULLs the child_run_id of OTHER runs' waits (a deleted
        child must not strand its waiting parent) — never touching a
        surviving run's rows;
     2b. a parent whose child was deleted is FAILED by the orchestrator's
        wait-due scanner (ChildLostError) instead of waiting forever — the
        recovery that makes SET NULL safe;
     3. deleting a parent run SET NULLs its children's parent_run_id instead
        of deleting them (the child keeps executing; only the lineage pointer
        dies);
     4. deleting a task row cascades to its schedule (a schedule is one task's
        cron registration);
     5. illegal status / kind / level / attempt / recovery / trigger values — one
        write per CHECK, all twelve constraints — are refused by the database
        (23514 check_violation) — the kernel's enums and the database agree;
     6. the 0011 migration is applied to a database that already contains
        ORPHANS (queue / waits / parent_run_id / child_run_id / schedule rows
        pointing at nothing — inserted after dropping the constraints, i.e. a
        pre-0011 schema) and cleans them instead of failing, so daemons
        auto-migrating at boot cannot be bricked;
     7. the real CLI prune deletes a terminal parent whose child is still
        RUNNING: the child survives with parent_run_id NULL, and no orphan
        queue / wait survives anywhere;
     8. cancel and retry through the kernel keep every relation intact (no
        orphan queue/wait/schedule after either).

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_CONSTRAINTS_DB override the database name prefix (default
                       better_trigger_constraints)
   ============================================================================= */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrate } from '@better-trigger/db';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { createKernel } from '@better-trigger/kernel';
import { runScenario, type Scenario } from '@better-trigger/testing';

/** apps/worker's entry, run from source — same resolution as spawnDaemon. */
const WORKER_ENTRY =
  process.env.BT_WORKER_ENTRY ??
  fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));

const DAY = 86_400_000;

const count = async (s: Scenario, sql: string, params: unknown[] = []): Promise<number> => {
  const res = await s.pool.query<{ count: string }>(sql, params);
  return Number(res.rows[0]?.count ?? 0);
};

/** One count per orphan shape; every assertion below that cares about
 *  referential integrity uses this. */
async function orphanCounts(
  s: Scenario,
): Promise<{ queue: number; waits: number; parent: number; schedules: number }> {
  const res = await s.pool.query<{ queue: string; waits: string; parent: string; schedules: string }>(
    `SELECT (SELECT count(*) FROM queue q
              WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = q.run_id))                            AS queue,
            (SELECT count(*) FROM waits w
              WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = w.run_id)
                 OR (w.child_run_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = w.child_run_id)))                AS waits,
            (SELECT count(*) FROM runs x
              WHERE x.parent_run_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = x.parent_run_id))                     AS parent,
            (SELECT count(*) FROM schedules s
              WHERE NOT EXISTS (SELECT 1 FROM tasks t
                 WHERE t.project_id = s.project_id AND t.env = s.env AND t.id = s.task_id))             AS schedules`,
  );
  const r = res.rows[0];
  return {
    queue: Number(r?.queue ?? 0),
    waits: Number(r?.waits ?? 0),
    parent: Number(r?.parent ?? 0),
    schedules: Number(r?.schedules ?? 0),
  };
}

/** The five FK + ten CHECK constraint names migration 0011 adds. */
const C5_FKS: Array<{ name: string; table: string }> = [
  { name: 'queue_run_id_runs_id_fk', table: 'queue' },
  { name: 'runs_parent_run_id_runs_id_fk', table: 'runs' },
  { name: 'schedules_project_id_env_task_id_tasks_project_id_env_id_fk', table: 'schedules' },
  { name: 'waits_run_id_runs_id_fk', table: 'waits' },
  { name: 'waits_child_run_id_runs_id_fk', table: 'waits' },
];
const C5_CHECKS = [
  'runs_status_check',
  'runs_attempt_check',
  'runs_recoveries_check',
  'run_steps_kind_check',
  'run_steps_status_check',
  'run_steps_attempt_check',
  'waits_kind_check',
  'waits_status_check',
  'workers_status_check',
  'logs_level_check',
];
/** The two CHECKs 0011 left out of the C5 set (backend-contract.md §2 lists
 *  both columns as closed enums) and 0016 adds; also re-applied by the
 *  orphan-migration scenario below, so they have to be dropped with the rest. */
const C16_CHECKS = ['runs_trigger_type_check', 'tasks_trigger_source_check'];
/** Every constraint name this scenario expects to exist on a migrated database. */
const CONSTRAINT_NAMES = [...C5_FKS.map((f) => f.name), ...C5_CHECKS, ...C16_CHECKS];

async function main(s: Scenario): Promise<void> {
  const kernel = createKernel({ pool: s.pool });

  /* -- 1. the constraints exist -------------------------------------------- */
  await s.check('migrations 0011 + 0016 ship the five FKs and twelve CHECKs', async () => {
    const res = await s.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
      [CONSTRAINT_NAMES],
    );
    s.assertEqual(
      res.rows.map((r) => r.conname).sort(),
      [...CONSTRAINT_NAMES].sort(),
      'constraints present',
    );
  });

  /* -- 2. manual DELETE FROM runs cascades queue + own waits, and SET NULLs
   *       the child_run_id of OTHER runs' waits ------------------------------ */
  await s.check('a manual run delete takes its queue and own waits; child refs SET NULL', async () => {
    // run 'del' has a queue row and its own pending duration wait; run 'watcher'
    // holds a wait AWAITING 'del' as its child (waits.child_run_id).
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
       VALUES ('run_del', 't', 'queued', 'api', now(), now()),
              ('run_watcher', 't', 'waiting', 'api', now(), now())`,
    );
    await s.pool.query(
      `INSERT INTO queue (run_id, available_at) VALUES ('run_del', now())`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, resume_at, status)
       VALUES ('run_del', 1, 'duration', now() + interval '1 hour', 'pending')`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, child_run_id, status)
       VALUES ('run_watcher', 1, 'run', 'run_del', 'pending')`,
    );

    await s.pool.query(`DELETE FROM runs WHERE id = 'run_del'`);

    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = 'run_del'`), 0, 'queue row');
    s.assertEqual(await count(s, `SELECT count(*) FROM waits WHERE run_id = 'run_del'`), 0, 'own waits');
    s.assertEqual(
      await count(s, `SELECT count(*) FROM waits WHERE child_run_id = 'run_del'`),
      0,
      'waits still pointing at the deleted run as child',
    );
    // The watcher survives — and so does its wait, with child_run_id NULLed
    // (ON DELETE SET NULL, NOT cascade): the wait row is the only record that
    // the parent was waiting on a child, so deleting it would strand the
    // 'waiting' parent permanently. The orchestrator recovers these instead
    // (next check).
    s.assertEqual(await count(s, `SELECT count(*) FROM runs WHERE id = 'run_watcher'`), 1, 'watcher survives');
    const wait = await s.pool.query<{ child_run_id: string | null; status: string }>(
      `SELECT child_run_id, status FROM waits WHERE run_id = 'run_watcher'`,
    );
    s.assertEqual(wait.rows.length, 1, 'watcher wait row survives');
    // No `?? sentinel` here — ?? coalesces the success value (NULL) into the
    // sentinel and the assertion could never pass.
    s.assertEqual(
      wait.rows[0] === undefined ? '(row gone)' : wait.rows[0].child_run_id,
      null,
      'watcher wait child_run_id is NULL',
    );
    s.assertEqual(wait.rows[0]?.status, 'pending', 'watcher wait still pending');
    const orphans = await orphanCounts(s);
    s.assertEqual(orphans.queue + orphans.waits + orphans.parent + orphans.schedules, 0, 'no orphans anywhere');
    // Tidy up: the watcher's orphaned wait is the next check's subject.
    await s.pool.query(`DELETE FROM runs WHERE id = 'run_watcher'`);
  });

  /* -- 2b. P0: a parent whose child was deleted is FAILED, never stranded --- */
  await s.check('a parent whose child was deleted is failed by the orchestrator', async () => {
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, parent_run_id, created_at, updated_at)
       VALUES ('run_p0_parent', 't', 'waiting', 'api', NULL, now(), now()),
              ('run_p0_child', 't', 'running', 'subtask', 'run_p0_parent', now(), now())`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, child_run_id, status)
       VALUES ('run_p0_parent', 1, 'run', 'run_p0_child', 'pending')`,
    );
    // The manual DELETE that CASCADE used to turn into a stranded parent.
    await s.pool.query(`DELETE FROM runs WHERE id = 'run_p0_child'`);
    s.assertEqual(
      await count(s, `SELECT count(*) FROM runs WHERE id = 'run_p0_parent' AND status = 'waiting'`),
      1,
      'parent still waiting after child delete (wait row survived, child_run_id NULL)',
    );

    // The orchestrator's wait-due scanner must recover it: fail the parent
    // (ChildLostError) instead of leaving it 'waiting' with no path back.
    const h = kernel.startOrchestrator({
      waits: true,
      cron: false,
      reaper: false,
      workerOffline: false,
      timerIntervalMs: 50,
    });
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const row = await s.pool.query<{ status: string; error: unknown }>(
          `SELECT status, error FROM runs WHERE id = 'run_p0_parent'`,
        );
        if (row.rows[0]?.status === 'failed') break;
        if (Date.now() > deadline) s.fail('parent was never failed — still stranded');
        await new Promise((r) => setTimeout(r, 100));
      }
      const row = await s.pool.query<{ status: string; error: { name?: string } }>(
        `SELECT status, error FROM runs WHERE id = 'run_p0_parent'`,
      );
      s.assertEqual(row.rows[0]?.error?.name, 'ChildLostError', 'parent error names the lost child');
      s.assertEqual(
        await count(s, `SELECT count(*) FROM waits WHERE run_id = 'run_p0_parent' AND status = 'pending'`),
        0,
        'orphan wait no longer pending (canceled by terminalFail)',
      );
    } finally {
      h.stop();
    }
    const orphans = await orphanCounts(s);
    s.assertEqual(orphans.queue + orphans.waits + orphans.parent + orphans.schedules, 0, 'no orphans after recovery');
  });

  /* -- 3. parent_run_id is SET NULL, never cascades the child away ---------- */
  await s.check('deleting a parent SET NULLs its children, never deletes them', async () => {
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, parent_run_id, created_at, updated_at)
       VALUES ('run_parent', 't', 'completed', 'api', NULL, now(), now()),
               ('run_child', 't', 'running', 'api', 'run_parent', now(), now())`,
    );
    await s.pool.query(`DELETE FROM runs WHERE id = 'run_parent'`);

    const child = await s.pool.query<{ parent_run_id: string | null }>(
      `SELECT parent_run_id FROM runs WHERE id = 'run_child'`,
    );
    // `?? '(row gone)'` would be wrong here: it coalesces the success value
    // (NULL) into the sentinel, so the assertion could never pass.
    s.assertEqual(
      child.rows[0] === undefined ? '(row gone)' : child.rows[0].parent_run_id,
      null,
      'child.parent_run_id after parent delete',
    );
  });

  /* -- 4. schedules cascade off their task --------------------------------- */
  await s.check('deleting a task cascades to its schedule', async () => {
    await s.pool.query(
      `INSERT INTO tasks (id, name, trigger_source) VALUES ('task_cron', 'task_cron', 'schedule')`,
    );
    await s.pool.query(
      `INSERT INTO schedules (id, task_id, cron_pattern, created_at, updated_at)
       VALUES ('sch_cron', 'task_cron', '* * * * *', now(), now())`,
    );
    await s.pool.query(`DELETE FROM tasks WHERE id = 'task_cron'`);
    s.assertEqual(await count(s, `SELECT count(*) FROM schedules WHERE id = 'sch_cron'`), 0, 'schedule after task delete');
  });

  /* -- 5. the database refuses illegal states ------------------------------ */
  await s.check('illegal status / kind / level / trigger writes are refused (23514)', async () => {
    let rejected = 0;
    const expectCheckViolation = async (sql: string, params: unknown[], label: string) => {
      try {
        await s.pool.query(sql, params);
        s.fail(`${label}: insert succeeded, CHECK did not fire`);
      } catch (err) {
        // Only a 23514 check_violation counts; anything else (including the
        // AssertionFailure thrown above) propagates and fails the check.
        if ((err as { code?: string }).code === '23514') {
          rejected += 1;
          return;
        }
        throw err;
      }
    };

    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
       VALUES ('run_good', 't', 'queued', 'api', now(), now())`,
    );
    await expectCheckViolation(
      `UPDATE runs SET status = 'suspended' WHERE id = 'run_good'`,
      [],
      'runs.status suspended',
    );
    await expectCheckViolation(
      `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
       VALUES ('run_bad', 't', 'bogus', 'api', now(), now())`,
      [],
      'runs.status bogus',
    );
    await expectCheckViolation(
      `INSERT INTO run_steps (run_id, seq, kind, status)
       VALUES ('run_good', 1, 'nope', 'completed')`,
      [],
      'run_steps.kind nope',
    );
    await expectCheckViolation(
      `INSERT INTO waits (run_id, step_seq, kind, status) VALUES ('run_good', 1, 'paused', 'pending')`,
      [],
      'waits.kind paused',
    );
    await expectCheckViolation(
      `INSERT INTO waits (run_id, step_seq, kind, status) VALUES ('run_good', 2, 'duration', 'paused')`,
      [],
      'waits.status paused',
    );
    await expectCheckViolation(
      `INSERT INTO logs (run_id, level, message) VALUES ('run_good', 'fatal', 'boom')`,
      [],
      'logs.level fatal',
    );
    // The remaining 0011 CHECKs, one write each, so every one is live-tested:
    await expectCheckViolation(
      `INSERT INTO run_steps (run_id, seq, kind, status) VALUES ('run_good', 2, 'step', 'bogus')`,
      [],
      'run_steps.status bogus',
    );
    await expectCheckViolation(
      `INSERT INTO workers (id, code_version, runtime, tasks, concurrency, status)
       VALUES ('w_bad', 'v1', 'bun', '[]'::jsonb, 1, 'bogus')`,
      [],
      'workers.status bogus',
    );
    await expectCheckViolation(
      `INSERT INTO runs (id, task_id, status, trigger_type, attempt, created_at, updated_at)
       VALUES ('run_attempt0', 't', 'queued', 'api', 0, now(), now())`,
      [],
      'runs.attempt 0',
    );
    await expectCheckViolation(
      `INSERT INTO run_steps (run_id, seq, kind, status, attempt)
       VALUES ('run_good', 3, 'step', 'completed', 0)`,
      [],
      'run_steps.attempt 0',
    );
    await expectCheckViolation(
      `INSERT INTO runs (id, task_id, status, trigger_type, recoveries, created_at, updated_at)
       VALUES ('run_rec_neg', 't', 'queued', 'api', -1, now(), now())`,
      [],
      'runs.recoveries -1',
    );
    await expectCheckViolation(
      `INSERT INTO runs (id, task_id, status, trigger_type, recoveries, created_at, updated_at)
       VALUES ('run_rec_over', 't', 'queued', 'api', 11, now(), now())`,
      [],
      'runs.recoveries 11 > max_recoveries 10',
    );
    // The two closed sets 0016 adds on top of 0011's.
    await expectCheckViolation(
      `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
       VALUES ('run_bad_trigger', 't', 'queued', 'webhook', now(), now())`,
      [],
      "runs.trigger_type 'webhook'",
    );
    await expectCheckViolation(
      `INSERT INTO tasks (id, name, trigger_source) VALUES ('task_bad_source', 'x', 'webhook')`,
      [],
      "tasks.trigger_source 'webhook'",
    );
    s.assertEqual(rejected, 14, 'all fourteen illegal writes refused');
  });

  /* -- 6. the migration survives a database full of orphans ----------------- */
  await s.check('0011 cleans orphans before adding the constraints', async () => {
    // Rebuild the pre-0011 shape, then create exactly the rows that would make
    // ADD CONSTRAINT fail — and with it every daemon's boot. ALL of 0011's
    // constraints go (the CHECKs too): the re-run re-adds every one, and an
    // existing constraint would fail it with a duplicate_object error instead.
    // 0012..0016 are younger than 0011, so everything they add must be dropped
    // and de-journaled as well, or their CREATE statements fail on the re-migrate.
    const checkTables: Array<{ name: string; table: string }> = [
      { name: 'runs_status_check', table: 'runs' },
      { name: 'runs_attempt_check', table: 'runs' },
      { name: 'runs_recoveries_check', table: 'runs' },
      { name: 'run_steps_kind_check', table: 'run_steps' },
      { name: 'run_steps_status_check', table: 'run_steps' },
      { name: 'run_steps_attempt_check', table: 'run_steps' },
      { name: 'waits_kind_check', table: 'waits' },
      { name: 'waits_status_check', table: 'waits' },
      { name: 'workers_status_check', table: 'workers' },
      { name: 'logs_level_check', table: 'logs' },
      { name: 'runs_trigger_type_check', table: 'runs' },
      { name: 'tasks_trigger_source_check', table: 'tasks' },
    ];
    for (const fk of C5_FKS) {
      await s.pool.query(`ALTER TABLE ${fk.table} DROP CONSTRAINT ${fk.name}`);
    }
    for (const c of checkTables) {
      await s.pool.query(`ALTER TABLE ${c.table} DROP CONSTRAINT ${c.name}`);
    }
    // Undo the schema effects of the migrations younger than 0011 so the
    // re-migrate re-applies them cleanly: 0012's CREATE INDEX needs waits_run_idx
    // gone, 0013's DROP INDEX needs queue_available_priority_idx to exist first
    // (the pre-0013 shape this fixture rebuilds), and 0014/0015's unique index
    // and retry-operations table must go or their CREATE statements fail on the
    // re-migrate, and so must 0016's four FK-support indexes on the tables this
    // fixture keeps (its two on run_retry_operations die with that table) — its
    // logs_run_id_idx rebuild needs no undo, since 0016 leads with a DROP.
    // De-journal 0011..0016: the migrator skips everything at or
    // below the newest remaining journal row's created_at, so leaving any of
    // 0014/0015/0016 journaled would silently skip 0011's cleanups as well.
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
    await s.pool.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE hash IN (
         SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 6)`,
    );
    // Orphan queue row + orphan wait (run_id and child_run_id variants) +
    // orphan parent_run_id + orphan schedule, all pointing at 'run_gone'.
    await s.pool.query(`INSERT INTO queue (run_id, available_at) VALUES ('run_gone', now())`);
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, status)
       VALUES ('run_gone', 1, 'duration', 'pending')`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, child_run_id, status)
       VALUES ('run_waiter', 1, 'run', 'run_gone', 'pending')`,
    );
    // A wait whose RUN exists but whose child does not: the cleanup must SET
    // NULL its child_run_id (not delete the row — deleting would strand the
    // 'waiting' parent; the orchestrator recovers the NULLed wait instead).
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, created_at, updated_at)
       VALUES ('run_live_parent', 't', 'waiting', 'api', now(), now())`,
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, child_run_id, status)
       VALUES ('run_live_parent', 1, 'run', 'run_gone', 'pending')`,
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

    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = 'run_gone'`), 0, 'orphan queue');
    s.assertEqual(await count(s, `SELECT count(*) FROM waits WHERE run_id = 'run_gone'`), 0, 'orphan wait (run_id)');
    s.assertEqual(
      await count(s, `SELECT count(*) FROM waits WHERE child_run_id = 'run_gone'`),
      0,
      'orphan wait (child_run_id)',
    );
    const liveWait = await s.pool.query<{ child_run_id: string | null }>(
      `SELECT child_run_id FROM waits WHERE run_id = 'run_live_parent'`,
    );
    // No `?? sentinel` — it coalesces the success value (NULL) into the
    // sentinel, so the assertion could never pass.
    s.assertEqual(
      liveWait.rows[0] === undefined ? '(row gone)' : liveWait.rows[0].child_run_id,
      null,
      'live parent wait child_run_id SET NULL',
    );
    const parent = await s.pool.query<{ parent_run_id: string | null }>(
      `SELECT parent_run_id FROM runs WHERE id = 'run_orphan_parent'`,
    );
    s.assertEqual(parent.rows[0]?.parent_run_id, null, 'orphan parent_run_id set to NULL');
    s.assertEqual(await count(s, `SELECT count(*) FROM schedules WHERE id = 'sch_orphan'`), 0, 'orphan schedule');
    // Scaffolding rows cleaned up: they only existed to make ADD CONSTRAINT
    // fail (and to prove the SET NULL cleanup), and must not leak into the
    // checks that follow.
    await s.pool.query(`DELETE FROM runs WHERE id IN ('run_live_parent', 'run_orphan_parent', 'run_waiter')`);
    // And the constraints are back, so all of the above still holds.
    const res = await s.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
      [CONSTRAINT_NAMES],
    );
    s.assertEqual(res.rows.length, CONSTRAINT_NAMES.length, 'constraints after the re-run migration');
  });

  /* -- 7. prune: terminal parent deleted, running child survives with NULL -- */
  await s.check('prune deletes a terminal parent but keeps its running child', async () => {
    const finished = new Date(Date.now() - 40 * DAY).toISOString();
    await s.pool.query(
      `INSERT INTO runs (id, task_id, status, trigger_type, parent_run_id, finished_at, created_at, updated_at)
       VALUES ('run_prune_parent', 't', 'completed', 'api', NULL, $1, now() - interval '40 days', $1),
              ('run_prune_child', 't', 'running', 'subtask', 'run_prune_parent', NULL, now(), now()),
              ('run_prune_stray', 't', 'failed', 'api', NULL, $1, now() - interval '40 days', $1)`,
      [finished],
    );
    // A leftover queue row + resolved wait on the stray terminal run — the
    // exact rows that used to dangle after a run ended some other way.
    await s.pool.query(`INSERT INTO queue (run_id, available_at) VALUES ('run_prune_stray', now())`);
    await s.pool.query(
      `INSERT INTO waits (run_id, step_seq, kind, status) VALUES ('run_prune_stray', 1, 'duration', 'completed')`,
    );

    const run = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn('bun', [WORKER_ENTRY, 'prune', '--older-than', '30d', '--no-migrate'], {
        env: { ...process.env, DATABASE_URL: s.db.url },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.on('data', (b) => (stdout += String(b)));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout }));
    });
    s.assertEqual(run.code, 0, 'prune exit code');
    s.assert(/deleted: 2 run\(s\)/.test(run.stdout), run.stdout);

    const child = await s.pool.query<{ parent_run_id: string | null }>(
      `SELECT parent_run_id FROM runs WHERE id = 'run_prune_child'`,
    );
    s.assertEqual(
      child.rows[0] === undefined ? '(row gone)' : child.rows[0].parent_run_id,
      null,
      'running child survives with parent_run_id NULL',
    );
    s.assertEqual(
      await count(s, `SELECT count(*) FROM runs WHERE id IN ('run_prune_parent','run_prune_stray')`),
      0,
      'pruned runs gone',
    );
    const orphans = await orphanCounts(s);
    s.assertEqual(orphans.queue + orphans.waits + orphans.parent + orphans.schedules, 0, 'no orphans after prune');
  });

  /* -- 8. cancel + retry through the kernel keep every relation intact ----- */
  await s.check('cancel and retry leave no orphans behind', async () => {
    await s.pool.query(
      `INSERT INTO tasks (id, name, trigger_source) VALUES ('constraints-task', 'constraints-task', 'api')`,
    );
    const created = await kernel.trigger({
      taskId: 'constraints-task',
      payload: null,
      namespace: DEFAULT_NAMESPACE,
    });
    const runId = created.runId;

    await kernel.cancelRun(runId, DEFAULT_NAMESPACE);
    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = $1`, [runId]), 0, 'queue row after cancel');
    s.assertEqual(
      await count(s, `SELECT count(*) FROM runs WHERE id = $1 AND status = 'canceled'`, [runId]),
      1,
      'run canceled',
    );

    const retried = await kernel.retryRun(runId, DEFAULT_NAMESPACE);
    const newId = retried.runId;
    s.assert(newId !== runId, `retry must create a new run (got ${newId})`);
    s.assertEqual(
      await count(s, `SELECT count(*) FROM runs WHERE id = $1 AND status = 'queued'`, [newId]),
      1,
      'retried run queued',
    );
    s.assertEqual(await count(s, `SELECT count(*) FROM queue WHERE run_id = $1`, [newId]), 1, 'retried run enqueued');

    const orphans = await orphanCounts(s);
    s.assertEqual(orphans.queue + orphans.waits + orphans.parent + orphans.schedules, 0, 'no orphans after cancel+retry');
  });
}

void runScenario(
  {
    name: 'constraints',
    what: 'database-level FKs and CHECK constraints are enforced',
    db: { name: 'better_trigger_constraints', envVar: 'BT_CONSTRAINTS_DB' },
  },
  main,
);
