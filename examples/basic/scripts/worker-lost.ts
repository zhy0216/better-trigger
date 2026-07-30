/* =============================================================================
   @better-trigger/example-basic — worker-lost e2e (reaper terminalFail +
   parent wakeup).

   Pins the reaper's terminal-failure path: when a worker dies holding a child
   that has NO retry budget left, the child must be failed as 'worker lost'
   AND its waiting parent must be woken (not left 'waiting' forever).

   Runs on @better-trigger/testing (runScenario provisions + migrates the
   database; spawnDaemon/killDaemon inject the fault) with two daemons: an API
   node (no --tasks) that serves the scenario's client and keeps a reaper alive,
   plus an executor node (--tasks worker-lost-tasks.ts --no-serve) that gets
   killed.

   Flow: spawn the executor → trigger wl-parent (which triggerAndWaits
   wl-child, retry { maxAttempts: 1 }) → SIGKILL the executor while the child
   is 'running' (parent 'waiting') → restart an executor. A reaper (500ms,
   lease 3s) finds the child's expired lease at max attempts → terminalFail:
   child 'failed' with error 'worker lost', parent re-queued. The new executor
   replays the parent; the cached trigger-and-wait step yields ok:false and the
   parent completes.

   Asserts:
     - child ends 'failed' with error.message 'worker lost', attempt still 1
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

  /* -- SIGKILL while the child is running ---------------------------------- */
  // The child only exists once the parent's triggerAndWait committed (child +
  // pending 'run' wait + parent suspended, atomically) — so child 'running'
  // implies the parent is already 'waiting'.
  let childRunId = '';
  await waitFor(`wl-child run 'running'`, 30_000, async () => {
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
  s.ok(`SIGKILL while child ${childRunId} is 'running' (parent 'waiting')`);

  /* -- restart: reaper terminal-fails the child, parent wakes + completes --- */
  proc = spawnExecutor();
  const result = await client.waitForResult(handle.id, { timeoutMs: 60_000 });

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
  s.assert(
    child.run.error?.message === 'worker lost',
    `child error should be 'worker lost', got ${JSON.stringify(child.run.error)}`,
  );
  s.assert(
    child.run.attempt === 1,
    `child (maxAttempts 1) must never be retried, got attempt ${child.run.attempt}`,
  );
  s.ok(`child failed as 'worker lost' at attempt 1 (no retry)`);

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
