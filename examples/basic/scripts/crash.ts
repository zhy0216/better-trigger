/* =============================================================================
   @better-trigger/example-basic — crash-recovery e2e (lease/fencing/reaper).

   Runs on @better-trigger/testing (runScenario provisions + migrates the
   database, createMarker owns the exactly-once probe, spawnDaemon/killDaemon do
   the fault injection) and drives two daemons —

     · an API node (no --tasks) that serves HTTP and runs the lease reaper. It
       survives every kill, so the scenario's client keeps answering and leases
       still get reaped while no executor is alive.
     · an executor node (--tasks crash-tasks.ts --no-serve) that claims and
       runs. This is the one that gets SIGKILLed.

   The executor is SIGKILLed at three points:

     ① after "step1" hits the marker file (mid pure-sleep, run 'running')
     ② after the run is observed 'waiting'  (suspended on wait.for("2s"))
     ③ after a restart brings the run back to 'running' (post-resume sleep)

   After every kill a fresh executor is spawned; a reaper (500ms) must release
   the expired lease (3s) so the new executor can reclaim under a bumped
   fencing token. Final assertions prove exactly-once durable steps:

     - run completed, output echoes the payload
     - marker file has exactly 1 "step1" line and exactly 1 "step2" line
     - step ledger is exactly [step, wait, step], with a gap-free seq prefix
     - attempt is STILL 1 and recoveries >= 2 (one recovery per reaped kill;
       the 'waiting' kill costs none). Losing a worker is infrastructure, so it
       spends the recovery budget and not the user's retries (C4).

   Mid-flight (while 'waiting', before kill-②) it also asserts that kill-①
   recovery cost exactly one recovery and no attempt, that the suspend released
   the claim (zero queue rows for the run), and it snapshots the ledger so the
   shared append-only invariant covers the two remaining kills.

   Env:
     DATABASE_URL  base connection derived from it; default
                   postgres://localhost:5432/better_trigger
     BT_CRASH_DB   override the provisioned database name (default
                   better_trigger_crash)
     BT_CRASH_PORT port the API node listens on (default 4902)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  countQueueRows,
  createMarker,
  killDaemon,
  portFromEnv,
  runScenario,
  sleep,
  spawnDaemon,
  startDaemon,
  waitFor,
  waitForStatus,
  waitForTasks,
  type Daemon,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';

const PORT = portFromEnv('BT_CRASH_PORT', 4902);
const TASKS_MODULE = fileURLToPath(new URL('./crash-tasks.ts', import.meta.url));

async function main(s: Scenario): Promise<void> {
  const marker = createMarker('bt-crash');
  s.log(`marker ${marker.file}`);

  /* -- executor nodes (short lease + fast reaper keep recovery quick) ------- */
  const spawnExecutor = (): Daemon =>
    spawnDaemon({
      databaseUrl: s.db.url,
      tasks: TASKS_MODULE,
      serve: false,
      concurrency: 1,
      leaseMs: 3_000,
      reaperIntervalMs: 500,
      env: marker.env,
    });

  // The API node: serves the client and keeps a reaper alive across every kill.
  const api = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    reaperIntervalMs: 500,
  });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  /** runs.recoveries — engine bookkeeping, not part of the public run record. */
  const recoveriesOf = async (runId: string): Promise<number> =>
    (
      await s.pool.query<{ recoveries: number }>(`SELECT recoveries FROM runs WHERE id = $1`, [
        runId,
      ])
    ).rows[0]!.recoveries;

  /* -- boot executor #1 and trigger the run -------------------------------- */
  let proc = spawnExecutor();
  // Whatever the body does, the last executor must not outlive the scenario.
  s.cleanup(() => proc.stop());

  await waitForTasks(s.pool, ['crash-test']);
  s.ok('executor #1 up, crash-test registered');

  const payload = { note: 'survive-the-crash' };
  const handle = await client.trigger('crash-test', payload);
  s.log(`run: ${handle.id}`);

  /* -- kill point ① : mid-sleep after step1 -------------------------------- */
  await waitFor(
    '"step1" marker line (durable step committed)',
    30_000,
    () => marker.count('step1') >= 1,
  );
  await sleep(1_000); // stay inside the 4s sleep window, past the step commit
  await killDaemon(proc);
  s.ok('kill ① — SIGKILL during post-step1 sleep (run running, lease held)');

  /* -- executor #2: reclaim after reap, run to 'waiting', kill ② ------------ */
  proc = spawnExecutor();
  await waitForStatus(client, handle.id, 'waiting', { timeoutMs: 60_000 });

  // Kill-① recovery must have cost exactly ONE recovery and NO attempt (C4):
  // reap → recoveries 1, reclaim + replay by executor #2 on the same attempt.
  {
    const mid = await client.getRunDetail(handle.id);
    s.assert(
      mid.run.attempt === 1,
      `a SIGKILLed worker must not spend an attempt, got ${mid.run.attempt}`,
    );
    const midRecoveries = await recoveriesOf(handle.id);
    s.assert(
      midRecoveries === 1,
      `kill-① should have cost exactly 1 recovery, got ${midRecoveries}`,
    );
    s.ok('kill-① recovery cost exactly one recovery, attempt untouched (1)');

    // Suspend must have released the claim: no queue row while 'waiting'.
    const queued = await countQueueRows(s.pool, handle.id);
    s.assert(
      queued === 0,
      `expected 0 queue rows while 'waiting' (suspend releases the claim), got ${queued}`,
    );
    s.ok(`no queue row while 'waiting' (suspend released the claim)`);

    // Baseline for the append-only invariant: seq 0 is committed and must be
    // byte-identical after the two kills still to come.
    const before = await s.inv.assertNoStepRewrites(handle.id);
    s.ok(`ledger snapshot taken mid-flight (${before.length} committed step row(s))`);
  }

  await killDaemon(proc);
  s.ok(`kill ② — SIGKILL while run is 'waiting' (worker held no claim)`);

  /* -- executor #3: resume the wait, back to 'running', kill ③ -------------- */
  proc = spawnExecutor();
  await waitForStatus(client, handle.id, 'running', { timeoutMs: 60_000 });
  await killDaemon(proc);
  s.ok(`kill ③ — SIGKILL during post-resume sleep (run running again)`);

  /* -- executor #4: reclaim and finish ------------------------------------- */
  proc = spawnExecutor();
  const result = await client.waitForResult(handle.id, { timeoutMs: 60_000 });

  /* -- final assertions ---------------------------------------------------- */
  s.assert(result.status === 'completed', `run should complete, got '${result.status}'`);
  s.ok('run completed after 3 kills');

  s.assertEqual(result.output, payload, 'output should echo the payload');
  s.ok('output echoes the payload');

  const step1Lines = marker.count('step1');
  const step2Lines = marker.count('step2');
  s.assert(step1Lines === 1, `marker should have exactly 1 "step1" line, got ${step1Lines}`);
  s.assert(step2Lines === 1, `marker should have exactly 1 "step2" line, got ${step2Lines}`);
  s.ok('marker file: step1 ×1, step2 ×1 (durable steps ran exactly once)');

  // The ledger shape, asserted straight off the database: the kinds in order
  // AND a gap-free 0..n-1 seq prefix (a hole means a step row was lost).
  await s.inv.assertSeqContiguous(handle.id, { kinds: ['step', 'wait', 'step'] });
  s.ok('step ledger is exactly [step, wait, step] over a gap-free seq prefix');

  // Compared against the mid-flight snapshot: nothing rewrote seq 0 while the
  // run was reclaimed twice under bumped fencing tokens.
  await s.inv.assertNoStepRewrites(handle.id);
  s.ok('no committed step row was rewritten across the three kills');

  const detail = await client.getRunDetail(handle.id);
  s.assert(
    detail.run.attempt === 1,
    `three SIGKILLs must not spend a single attempt, got ${detail.run.attempt}`,
  );
  const finalRecoveries = await recoveriesOf(handle.id);
  s.assert(
    finalRecoveries >= 2,
    `recoveries should be >= 2 after two reaped kills, got ${finalRecoveries}`,
  );
  s.ok(`attempt = 1, recoveries = ${finalRecoveries} (>= 2)`);

  // Last: the terminal run must stop moving even though a reaper is still alive
  // on the API node and executor #4 is still draining.
  await s.inv.assertTerminalImmutable(handle.id);
  s.ok('terminal run holds no queue row / pending wait and stopped changing');
}

await runScenario(
  {
    name: 'crash',
    what: 'steps stay exactly-once across SIGKILL',
    db: { name: 'better_trigger_crash', envVar: 'BT_CRASH_DB' },
  },
  main,
);
