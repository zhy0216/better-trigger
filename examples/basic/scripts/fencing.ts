/* =============================================================================
   @better-trigger/example-basic — fencing-token e2e (kernel-level).

   Two workers race over one run, straight against createKernel (no SDK
   executor): worker A claims with a tiny lease and never heartbeats; the
   reaper releases the expired claim; worker B reclaims and the fencing token
   increments by exactly 1. Every fenced mutation A attempts with its stale
   token (reportStep / completeRun / suspendRun / failRun retry-shaped +
   abort / waitForChildRun / batchTriggerChild) must be rejected with
   StaleLeaseError AND zero state change, while B's writes land normally.
   A second run then pins token monotonicity across suspend/resume: the
   post-resume claim's token is strictly greater than the pre-suspend token,
   which no longer authorizes writes.

   Runs on @better-trigger/testing: runScenario provisions + migrates the
   scenario's database, owns the pool, runs teardown and folds the verdict into
   the exit code. No daemon and no HTTP — this one drives @better-trigger/kernel
   directly, because the invariant under test lives below the transport.

   Env:
     DATABASE_URL    base connection derived from it; default
                     postgres://localhost:5432/better_trigger
     BT_FENCING_DB   override the provisioned database name (default
                     better_trigger_fencing)
   ============================================================================= */
import { createKernel, StaleLeaseError } from '@better-trigger/kernel';
import { runScenario, sleep, waitForStatus, type Scenario } from '@better-trigger/testing';

async function main(s: Scenario): Promise<void> {
  const pool = s.pool;
  const kernel = createKernel({ pool });
  // The only scenario that hands its database back: its ledgers are synthetic
  // (seqs written by hand), so there is nothing a post-mortem would want.
  s.cleanup(() => s.db.drop());

  /* -------------------------------------------------------------------------
   * State-snapshot helpers — used to prove stale ops are rejected with ZERO
   * state change (not merely that they throw). Scenario-local on purpose: no
   * other scenario reaches below the transport like this.
   * ----------------------------------------------------------------------- */
  interface StateSnap {
    status: string;
    attempt: number;
    output: unknown;
    error: unknown;
    token: number;
    lockedBy: string | null;
    hasQueueRow: boolean;
    steps: Array<{ seq: number; status: string }>;
    waitCount: number;
    /** Total rows in runs — catches stale child creation (waitForChildRun / batchTriggerChild). */
    totalRuns: number;
  }

  async function snapshot(id: string): Promise<StateSnap> {
    const run = (
      await pool.query(
        `SELECT status, attempt, output, error, fencing_token FROM runs WHERE id = $1`,
        [id],
      )
    ).rows[0];
    s.assert(run, `snapshot: run ${id} not found`);
    const q = (await pool.query(`SELECT locked_by FROM queue WHERE run_id = $1`, [id])).rows[0];
    const steps = (
      await pool.query(`SELECT seq, status FROM run_steps WHERE run_id = $1 ORDER BY seq`, [id])
    ).rows;
    const waits = (
      await pool.query(`SELECT count(*)::int AS n FROM waits WHERE run_id = $1`, [id])
    ).rows[0];
    const runs = (await pool.query(`SELECT count(*)::int AS n FROM runs`)).rows[0];
    return {
      status: run.status,
      attempt: run.attempt,
      output: run.output,
      error: run.error,
      token: Number(run.fencing_token),
      lockedBy: q ? q.locked_by : null,
      hasQueueRow: !!q,
      steps: steps.map((row) => ({ seq: row.seq, status: row.status })),
      waitCount: waits.n,
      totalRuns: runs.n,
    };
  }

  /**
   * Run an op holding stale credentials: it must throw StaleLeaseError AND leave
   * the observable world identical (runs / queue / run_steps / waits untouched,
   * no new runs created).
   */
  async function expectStaleNoop(
    label: string,
    id: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    const before = await snapshot(id);
    let thrown: unknown = null;
    try {
      await fn();
    } catch (err) {
      thrown = err;
    }
    s.assert(thrown !== null, `${label} should have thrown`);
    s.assert(
      thrown instanceof StaleLeaseError,
      `${label}: expected StaleLeaseError, got ${String(thrown)}`,
    );
    const after = await snapshot(id);
    s.assert(
      JSON.stringify(after) === JSON.stringify(before),
      `${label}: state changed despite StaleLeaseError\n` +
        `  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`,
    );
    s.ok(`${label} → StaleLeaseError, zero state change`);
  }

  /* -- two workers, one task, one run -------------------------------------- */
  const manifest = [{ id: 'fenced-task', retry: { maxAttempts: 3 } }];
  const { workerId: workerA } = await kernel.registerWorker({
    name: 'fencing-a',
    codeVersion: 'v1',
    runtime: 'bun',
    concurrency: 1,
    tasks: manifest,
  });
  const { workerId: workerB } = await kernel.registerWorker({
    name: 'fencing-b',
    codeVersion: 'v1',
    runtime: 'bun',
    concurrency: 1,
    tasks: manifest,
  });
  s.ok(`registered workers A=${workerA} B=${workerB}`);

  const { runId } = await kernel.trigger({ taskId: 'fenced-task', payload: { n: 1 } });

  /* -- A claims with a tiny lease and goes silent (no heartbeat) ------------ */
  const [claimA] = await kernel.claimRuns({
    workerId: workerA,
    taskIds: ['fenced-task'],
    limit: 1,
    leaseMs: 300,
  });
  s.assert(claimA && claimA.id === runId, 'worker A should claim the run');
  const tokenA = claimA.fencingToken;
  s.ok(`A claimed with fencing token ${tokenA} (lease 300ms, never renewed)`);

  /* -- reaper releases the expired lease ----------------------------------- */
  const orch = kernel.startOrchestrator({ reaperIntervalMs: 500 });
  s.cleanup(() => orch.stop());
  await sleep(1_500); // lease long expired; reaper has run several times

  const reaped = await kernel.getRun(runId);
  s.assert(
    reaped.status === 'queued' && reaped.attempt === 2,
    `reaper should requeue the run as attempt 2, got status='${reaped.status}' attempt=${reaped.attempt}`,
  );
  s.ok('reaper released the zombie claim (run requeued, attempt 2)');

  /* -- B reclaims: token must increment by exactly 1 ------------------------ */
  const [claimB] = await kernel.claimRuns({
    workerId: workerB,
    taskIds: ['fenced-task'],
    limit: 1,
    leaseMs: 60_000,
  });
  s.assert(claimB && claimB.id === runId, 'worker B should reclaim the run');
  s.assert(
    claimB.fencingToken === tokenA + 1,
    `reclaim should bump the token by 1 (${tokenA} → ${tokenA + 1}), got ${claimB.fencingToken}`,
  );
  s.ok(`B reclaimed with fencing token ${claimB.fencingToken} (= A.token + 1)`);

  /* -- A's stale-token writes are rejected --------------------------------- */
  const nowIso = () => new Date().toISOString();

  try {
    await kernel.reportStep({
      runId,
      seq: 1,
      kind: 'step',
      label: 'zombie-step',
      status: 'completed',
      output: 'from-A',
      attempt: 1,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      workerId: workerA,
      fencingToken: tokenA,
    });
    s.fail('stale reportStep from A should have thrown');
  } catch (err) {
    s.assert(err instanceof StaleLeaseError, `expected StaleLeaseError, got ${String(err)}`);
    s.ok('A reportStep with stale token → StaleLeaseError');
  }

  try {
    await kernel.completeRun({ runId, output: 'from-A', workerId: workerA, fencingToken: tokenA });
    s.fail('stale completeRun from A should have thrown');
  } catch (err) {
    s.assert(err instanceof StaleLeaseError, `expected StaleLeaseError, got ${String(err)}`);
    s.ok('A completeRun with stale token → StaleLeaseError');
  }

  /* -- stale write at a seq the legit worker NEVER writes: rejected-with-no-
   *    state-change, not just thrown (seq 99 must have no row afterwards) --- */
  await expectStaleNoop('A reportStep(seq 99) with stale token', runId, () =>
    kernel.reportStep({
      runId,
      seq: 99,
      kind: 'step',
      label: 'zombie-99',
      status: 'completed',
      output: 'from-A',
      attempt: 1,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      workerId: workerA,
      fencingToken: tokenA,
    }),
  );
  {
    const seq99 = await pool.query(`SELECT 1 FROM run_steps WHERE run_id = $1 AND seq = 99`, [
      runId,
    ]);
    s.assert(seq99.rows.length === 0, `seq 99 must have no step row, got ${seq99.rows.length}`);
    const now = await kernel.getRun(runId);
    s.assert(
      now.status === 'running' && now.attempt === 2,
      `run must stay running at attempt 2 after the rejected write, got status='${now.status}' attempt=${now.attempt}`,
    );
    s.ok('seq 99 has no row; run status/attempt unchanged (running, attempt 2)');
  }

  /* -- EVERY fenced mutation rejects stale credentials with zero state change */
  const staleCreds = { workerId: workerA, fencingToken: tokenA };

  await expectStaleNoop('A suspendRun (wait.for) with stale token', runId, () =>
    kernel.suspendRun({
      runId,
      seq: 98,
      label: 'zombie-wait',
      kind: 'duration',
      resumeAt: new Date(Date.now() + 60_000).toISOString(),
      ...staleCreds,
    }),
  );

  await expectStaleNoop('A failRun (retry-shaped) with stale token', runId, () =>
    kernel.failRun({
      runId,
      error: { message: 'zombie transient failure' },
      retry: { maxAttempts: 5, baseMs: 100 },
      ...staleCreds,
    }),
  );

  await expectStaleNoop('A failRun (abort:true) with stale token', runId, () =>
    kernel.failRun({
      runId,
      error: { message: 'zombie abort' },
      abort: true,
      ...staleCreds,
    }),
  );

  await expectStaleNoop('A waitForChildRun (triggerAndWait) with stale token', runId, () =>
    kernel.waitForChildRun({
      runId,
      seq: 97,
      label: 'zombie-child',
      taskId: 'fenced-task',
      payload: { child: true },
      ...staleCreds,
    }),
  );

  await expectStaleNoop('A batchTriggerChild with stale token', runId, () =>
    kernel.batchTriggerChild({
      runId,
      seq: 96,
      label: 'zombie-batch',
      items: [
        { taskId: 'fenced-task', payload: { i: 0 } },
        { taskId: 'fenced-task', payload: { i: 1 } },
      ],
      ...staleCreds,
    }),
  );

  /* -- B's writes land normally -------------------------------------------- */
  await kernel.reportStep({
    runId,
    seq: 1,
    kind: 'step',
    label: 'real-step',
    status: 'completed',
    output: 'from-B',
    attempt: 2,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    workerId: workerB,
    fencingToken: claimB.fencingToken,
  });
  await kernel.completeRun({
    runId,
    output: 'done-by-B',
    workerId: workerB,
    fencingToken: claimB.fencingToken,
  });
  s.ok('B reportStep + completeRun accepted under the current token');

  /* -- final state --------------------------------------------------------- */
  const detail = await kernel.getRunDetail(runId);
  s.assert(detail.run.status === 'completed', `run should be completed, got '${detail.run.status}'`);
  s.assert(
    detail.run.output === 'done-by-B',
    `output should be B's, got ${JSON.stringify(detail.run.output)}`,
  );
  s.assert(
    detail.steps.length === 1 &&
      detail.steps[0].label === 'real-step' &&
      detail.steps[0].output === 'from-B',
    `expected exactly 1 step row (B's), got ${JSON.stringify(detail.steps)}`,
  );
  s.assert(detail.run.attempt === 2, `attempt should be 2, got ${detail.run.attempt}`);
  s.ok('run completed with a single step row (B) and attempt = 2');

  // Shared invariants. assertSeqContiguous is deliberately NOT asserted in this
  // scenario: it writes seqs by hand (1, 96..99) instead of letting a replay
  // executor allocate them, so a gap-free 0..n-1 prefix is not a property here.
  await s.inv.assertNoStepRewrites(runId);
  await s.inv.assertTerminalImmutable(runId);
  s.ok('invariants: run #1 ledger append-only, terminal state stopped moving');

  /* -- regression: token monotonicity across suspend/resume -----------------
   * The token lives on runs, while suspend DELETEs the queue row and resume
   * re-INSERTs it — the post-resume claim's token must therefore be strictly
   * greater than the pre-suspend token (never reset), and a write holding the
   * pre-suspend token must be rejected. ----------------------------------- */
  const { runId: runId2 } = await kernel.trigger({ taskId: 'fenced-task', payload: { n: 2 } });

  const [preClaim] = await kernel.claimRuns({
    workerId: workerB,
    taskIds: ['fenced-task'],
    limit: 1,
    leaseMs: 60_000,
  });
  s.assert(preClaim && preClaim.id === runId2, 'worker B should claim run #2');
  const preToken = preClaim.fencingToken;
  s.ok(`B claimed run #2 with pre-suspend token ${preToken}`);

  const { resumed } = await kernel.suspendRun({
    runId: runId2,
    seq: 1,
    label: 'short-wait',
    kind: 'duration',
    resumeAt: new Date(Date.now() + 1_200).toISOString(),
    workerId: workerB,
    fencingToken: preToken,
  });
  s.assert(!resumed, 'suspend with a future resumeAt must not resume synchronously');
  {
    const q = await pool.query(`SELECT 1 FROM queue WHERE run_id = $1`, [runId2]);
    s.assert(q.rows.length === 0, 'suspend should delete the queue row');
  }
  s.ok('run #2 suspended on wait.for (queue row deleted)');

  // The already-running orchestrator's wait scanner resumes it (~1.2s + 1s tick).
  await waitForStatus(kernel, runId2, 'queued', { timeoutMs: 10_000 });
  const [postClaim] = await kernel.claimRuns({
    workerId: workerA,
    taskIds: ['fenced-task'],
    limit: 1,
    leaseMs: 60_000,
  });
  s.assert(postClaim && postClaim.id === runId2, 'worker A should reclaim run #2 after resume');
  s.assert(
    postClaim.fencingToken > preToken,
    `post-resume token must be strictly greater than the pre-suspend token ` +
      `(${preToken}), got ${postClaim.fencingToken}`,
  );
  s.ok(
    `post-resume reclaim token ${postClaim.fencingToken} > pre-suspend token ${preToken} (monotonic across suspend/resume)`,
  );

  // A write still holding the pre-suspend token is rejected with no state change.
  await expectStaleNoop('B reportStep with pre-suspend token (post-resume)', runId2, () =>
    kernel.reportStep({
      runId: runId2,
      seq: 2,
      kind: 'step',
      label: 'pre-suspend-zombie',
      status: 'completed',
      output: 'stale',
      attempt: 1,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      workerId: workerB,
      fencingToken: preToken,
    }),
  );

  await kernel.completeRun({
    runId: runId2,
    output: 'resumed-done',
    workerId: workerA,
    fencingToken: postClaim.fencingToken,
  });
  {
    const run2 = await kernel.getRun(runId2);
    s.assert(
      run2.status === 'completed' && run2.output === 'resumed-done',
      `run #2 should complete under the live token, got status='${run2.status}' output=${JSON.stringify(run2.output)}`,
    );
  }
  s.ok('run #2 completed under the post-resume token');

  await s.inv.assertNoStepRewrites(runId2);
  await s.inv.assertTerminalImmutable(runId2);
  s.ok('invariants: run #2 ledger append-only, terminal state stopped moving');
}

await runScenario(
  {
    name: 'fencing',
    what: 'fencing tokens reject late writes',
    db: { name: 'better_trigger_fencing', envVar: 'BT_FENCING_DB' },
  },
  main,
);
