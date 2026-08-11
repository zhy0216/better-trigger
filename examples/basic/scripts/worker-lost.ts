/* =============================================================================
   @better-trigger/example-basic — worker-lost e2e (reaper recovery, then
   terminalFail + parent wakeup).

   Pins BOTH halves of the reaper's expired-lease path (todos/01 C4):

     1. a lost worker is infrastructure, not a failing task — the recovered run
        spends a `recovery`, never an `attempt`, so a task with maxAttempts 1
        survives the machine under it dying;
     2. once the recovery budget is gone the run is terminally 'worker lost',
        with an error that says WHICH budget ran out, and its waiting parent is
        woken (not left 'waiting' forever).

   Runs on @better-trigger/testing (runScenario provisions + migrates the
   database; spawnDaemon/killDaemon inject the fault) with two daemons: an API
   node (no --tasks) that serves the scenario's client and keeps a reaper alive,
   plus executor nodes (--tasks worker-lost-tasks.ts --no-serve) that get
   killed. The executors run with BETTER_TRIGGER_MAX_RECOVERIES=1 so the budget
   is exhausted by two SIGKILLs rather than the default ten — the child run is
   created by the executor's own kernel, so the stamp comes from its env.

   Flow: spawn executor #1 → trigger wl-parent (which triggerAndWaits wl-child,
   retry { maxAttempts: 1 }) → SIGKILL while the child is 'running' (parent
   'waiting') → a reaper (500ms, lease 3s) recovers the child: recoveries 1,
   attempt still 1, back on the queue → executor #2 picks it up and runs it
   again → SIGKILL again → this time recoveries (1) is at max_recoveries (1) →
   terminalFail: child 'failed' as 'worker lost', parent re-queued. Executor #3
   replays the parent; the cached trigger-and-wait step yields ok:false and the
   parent completes.

   Asserts:
     - after kill #1 the child is recovered: recoveries 1, attempt STILL 1
       (the user's retry budget was not charged for a dead machine)
     - after kill #2 the child ends 'failed', attempt still 1, with an error
       naming the exhausted recovery budget (and still saying 'worker lost')
     - parent ends 'completed' with output.ok === false + the child's error
     - parent carries exactly 1 completed 'trigger-and-wait' step
     - both runs satisfy the shared ledger invariants (seq contiguous,
       append-only, terminal state frozen) — including the child, whose
       terminal row was written by the reaper rather than by a worker

   Env:
     DATABASE_URL       base connection derived from it; default
                        postgres://localhost:5432/better_trigger
     BT_WORKER_LOST_DB  override the provisioned database name (default
                        better_trigger_worker_lost)
     BT_WORKER_LOST_PORT  port the API node listens on (default 4904)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  killDaemon,
  portFromEnv,
  runScenario,
  spawnDaemon,
  startDaemon,
  waitFor,
  waitForTasks,
  type Daemon,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';

const PORT = portFromEnv('BT_WORKER_LOST_PORT', 4904);
const TASKS_MODULE = fileURLToPath(new URL('./worker-lost-tasks.ts', import.meta.url));

async function main(s: Scenario): Promise<void> {
  /* -- executor nodes (short lease + fast reaper keep recovery quick) ------- */
  const spawnExecutor = (): Daemon =>
    spawnDaemon({
      databaseUrl: s.db.url,
      tasks: TASKS_MODULE,
      serve: false,
      concurrency: 2,
      leaseMs: 3_000,
      reaperIntervalMs: 500,
      // The child run is created by THIS process's kernel (triggerAndWait runs
      // in the executor), so this is the stamp it lands with: one recovery,
      // i.e. two SIGKILLs exhaust the budget instead of the default ten.
      env: { BETTER_TRIGGER_MAX_RECOVERIES: '1' },
    });

  // The API node: serves the client and keeps a reaper alive across the kill.
  const api = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    reaperIntervalMs: 500,
  });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  /* -- boot executor #1 and trigger the parent ----------------------------- */
  let proc = spawnExecutor();
  s.cleanup(() => proc.stop());

  await waitForTasks(s.pool, ['wl-parent', 'wl-child']);
  s.ok(`executor #1 up, wl-parent + wl-child registered`);

  const handle = await client.trigger('wl-parent', { note: 'lose-the-worker' });
  s.log(`parent run: ${handle.id}`);

  /* -- SIGKILL #1 while the child is running -------------------------------- */
  // The child only exists once the parent's triggerAndWait committed (child +
  // pending 'run' wait + parent suspended, atomically) — so child 'running'
  // implies the parent is already 'waiting'.
  // The three explicit gates below get 60s because each waits on a freshly
  // spawned daemon (bun startup + migrate + registration) and CI runs these
  // next to the unit suites, which spawn daemons of their own. Measured clean:
  // ~0.35s here, ~3.0s for the recovery gate (it must outlast the 3s lease),
  // ~1.15s for the second kill. The headroom is for a loaded machine, not for
  // a slow engine — a gate that blows past 60s is a real signal, so the last
  // one below also fails fast once its target becomes unreachable.
  let childRunId = '';
  await waitFor(`wl-child run 'running'`, 60_000, async () => {
    const res = await s.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM runs WHERE task_id = 'wl-child'`,
    );
    const row = res.rows[0];
    if (!row) return false;
    childRunId = row.id;
    return row.status === 'running';
  });
  const parentAtKill = await client.getRun(handle.id);
  s.assert(
    parentAtKill.status === 'waiting',
    `parent should be 'waiting' at kill time, got '${parentAtKill.status}'`,
  );
  await killDaemon(proc);
  s.ok(`SIGKILL #1 while child ${childRunId} is 'running' (parent 'waiting')`);

  /* -- the reaper RECOVERS it: recoveries + 1, attempt untouched ------------ */
  // recoveries/max_recoveries live only on the runs row (they are engine
  // bookkeeping, not part of the public run record), so this reads the table.
  const budget = async () =>
    (
      await s.pool.query<{ status: string; attempt: number; recoveries: number }>(
        `SELECT status, attempt, recoveries FROM runs WHERE id = $1`,
        [childRunId],
      )
    ).rows[0]!;

  proc = spawnExecutor();
  await waitFor(`wl-child recovered by the reaper`, 60_000, async () => {
    return (await budget()).recoveries === 1;
  });
  const afterFirstKill = await budget();
  s.assert(
    afterFirstKill.attempt === 1,
    `a lost worker must not spend an attempt, got attempt ${afterFirstKill.attempt}`,
  );
  s.assert(
    afterFirstKill.status !== 'failed',
    `child must survive its first lost worker, got '${afterFirstKill.status}'`,
  );
  s.ok(`child recovered: recoveries 1, attempt still 1 (maxAttempts 1 intact)`);

  /* -- SIGKILL #2: the recovery budget (1) is now spent --------------------- */
  // Fail fast rather than sit out the timeout: with max_recoveries 1 already
  // spent, a stall long enough to expire the 3s lease has the reaper terminal-
  // fail the child — after which 'running' is unreachable and every further
  // poll is dead time ending in a message that names neither the status nor the
  // budget. Reporting what it actually found is the difference between "the
  // machine was slow" and "the engine spent the budget early".
  await waitFor(`wl-child run 'running' again`, 60_000, async () => {
    const b = await budget();
    if (b.status === 'running') return true;
    if (b.status === 'failed' || b.status === 'completed' || b.status === 'canceled') {
      return {
        abort:
          `child reached terminal '${b.status}' (attempt ${b.attempt}, ` +
          `recoveries ${b.recoveries}) and can never be 'running' again`,
      };
    }
    return false;
  });
  await killDaemon(proc);
  s.ok(`SIGKILL #2 while the child is running on its recovered claim`);

  /* -- reaper terminal-fails the child, parent wakes + completes ------------ */
  proc = spawnExecutor();
  const result = await client.waitForResult(handle.id, undefined, { timeoutMs: 60_000 });

  s.assert(result.status === 'completed', `parent should complete, got '${result.status}'`);
  s.ok('parent completed after the worker was lost');

  const out = result.output as {
    ok: boolean;
    childRunId: string;
    error: { message?: string } | null;
  };
  s.assert(out.ok === false, `parent output.ok should be false, got ${JSON.stringify(out.ok)}`);
  s.assert(
    out.childRunId === childRunId,
    `parent output.childRunId should be ${childRunId}, got ${out.childRunId}`,
  );
  s.assert(
    !!out.error &&
      typeof out.error.message === 'string' &&
      out.error.message.includes('worker lost'),
    `parent output.error should carry 'worker lost', got ${JSON.stringify(out.error)}`,
  );
  s.ok(`parent output: ok=false with the child's 'worker lost' error`);

  const child = await client.getRunDetail(childRunId);
  s.assert(child.run.status === 'failed', `child should be 'failed', got '${child.run.status}'`);
  // The message is no longer a bare 'worker lost': it has to name the budget
  // that ran out, because the one the user configured (maxAttempts) did not.
  const childError = child.run.error?.message ?? '';
  s.assert(
    childError.includes('worker lost') && childError.includes('recovery budget exhausted'),
    `child error should be 'worker lost' + the exhausted recovery budget, got ` +
      JSON.stringify(child.run.error),
  );
  s.assert(
    childError.includes('1/1'),
    `child error should quote the spent recovery budget (1/1), got ${JSON.stringify(childError)}`,
  );
  s.assert(
    child.run.attempt === 1,
    `child (maxAttempts 1) must never be retried, got attempt ${child.run.attempt}`,
  );
  const finalRow = await budget();
  s.assert(
    finalRow.recoveries === 1,
    `child should die with its recovery budget spent (1), got ${finalRow.recoveries}`,
  );
  s.ok(`child failed as 'worker lost' with recoveries 1/1, attempt still 1`);

  const parentDetail = await client.getRunDetail(handle.id);
  const taw = parentDetail.steps.filter(
    (step) => step.kind === 'trigger-and-wait' && step.status === 'completed',
  );
  s.assert(taw.length === 1, `expected 1 completed 'trigger-and-wait' step, got ${taw.length}`);
  s.ok(`parent has exactly 1 completed 'trigger-and-wait' step`);

  /* -- shared ledger invariants -------------------------------------------- */
  // The parent's whole ledger is the single trigger-and-wait row, at seq 0.
  await s.inv.assertSeqContiguous(handle.id, { kinds: ['trigger-and-wait'] });
  await s.inv.assertNoStepRewrites(handle.id);
  await s.inv.assertTerminalImmutable(handle.id);
  s.ok('parent invariants: gap-free ledger, append-only, terminal state frozen');

  // The child never got to write a step; what matters is that the reaper's
  // terminal write is a real terminal state (finished_at, no queue row, no
  // pending wait) and that nothing touches it afterwards.
  await s.inv.assertSeqContiguous(childRunId, { kinds: [] });
  await s.inv.assertTerminalImmutable(childRunId);
  s.ok(`child invariants: reaper's 'worker lost' terminal state is final`);
}

await runScenario(
  {
    name: 'worker-lost',
    what: 'expired leases are reclaimed',
    db: { name: 'better_trigger_worker_lost', envVar: 'BT_WORKER_LOST_DB' },
  },
  main,
);
