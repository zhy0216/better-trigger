/* =============================================================================
   @better-trigger/example-basic — replay-drift acceptance scenario.

   Proves the guardrails against a mid-flight redeploy — the scenario a long
   ctx.wait makes routine, because a suspended run's ledger can outlive several
   deploys:

     ① runs.code_version is stamped at trigger time, so "which code shape was
        this run's ledger written against?" is answerable after the fact.
     ② the worker's code version fingerprints each run() body, so editing a task
        changes the version even though ids and cron are untouched. (Under the
        old id+cron-only signature both deploys below hash identically.)
     ③ kind drift — a wait row landing at a ctx.step() call site — is refused
        with an unconditional AbortError in BOTH replay modes, instead of
        feeding the wait row's empty output to a step whose body never ran.
     ④ label drift is arbitrated by the recorded label's fingerprint: a PURE
        rename keeps the strict/lenient split, but a rename PLUS an
        implementation change fails both modes with a "replay fingerprint
        mismatch" AbortError.

   Runs on @better-trigger/testing (runScenario provisions + migrates the
   database, createMarker owns the "did this body run?" probe, spawnDaemon swaps
   the deploys). Shape: an API node (no --tasks) serves HTTP and runs the
   orchestrator across the whole test, while executor nodes are swapped under it:

     deploy #1 (replay-drift-tasks-v1.ts) → both runs suspend on the wait →
                                            graceful stop (a deploy is a
                                            graceful stop; see the C4 note at
                                            the swap site)
     deploy #2 (replay-drift-tasks-v2.ts) → resumes the waits, then replays them
                                            against a run() with a step inserted
                                            at seq 1, where v1's ledger holds
                                            the wait row

   (The API node registers no tasks, so it runs bookkeeping only — waits/cron
   stay off. With no executor alive the runs stay suspended, which is what lets
   the scenario swap deploys deterministically.)

   Then the two strictness modes are contrasted on identical ledgers — and BOTH
   refuse the kind drift:
     drift-strict  → fails with AbortError, attempt stays 1 (no retry storm)
     drift-lenient → fails with AbortError too — kind drift is unconditional,
                     so lenient no longer reports success for a step whose body
                     never ran.

   A second swap (replay-drift-rename-tasks-v1/v2.ts) proves ④: renaming step
   "charge" → "charge-v2" AND rewriting its body fails rename-strict AND
   rename-lenient with the same non-retryable "replay fingerprint mismatch"
   AbortError.

   Env:
     DATABASE_URL   base connection derived from it; default
                    postgres://localhost:5432/better_trigger
     BT_DRIFT_DB    provisioned database name (default better_trigger_drift)
     BT_DRIFT_PORT  port the API node listens on (default 4903)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  createMarker,
  portFromEnv,
  readLatestCodeVersion,
  runScenario,
  sleep,
  spawnDaemon,
  startDaemon,
  waitFor,
  waitForTasks,
  type Daemon,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger, type RunStatus } from 'better-trigger';

const PORT = portFromEnv('BT_DRIFT_PORT', 4903);
const V1_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v1.ts', import.meta.url));
const V2_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v2.ts', import.meta.url));
const RENAME_V1_MODULE = fileURLToPath(new URL('./replay-drift-rename-tasks-v1.ts', import.meta.url));
const RENAME_V2_MODULE = fileURLToPath(new URL('./replay-drift-rename-tasks-v2.ts', import.meta.url));

/** Long enough to observe 'waiting' and kill deploy #1 before it resumes. */
const WAIT_FOR = '6s';

async function main(s: Scenario): Promise<void> {
  const marker = createMarker('bt-drift');
  s.log(`marker ${marker.file}`);

  const spawnExecutor = (tasksModule: string, label: string): Daemon =>
    spawnDaemon({
      databaseUrl: s.db.url,
      tasks: tasksModule,
      serve: false,
      concurrency: 2,
      name: label,
      env: { ...marker.env, BT_DRIFT_WAIT: WAIT_FOR },
    });

  // API node: HTTP + orchestrator. Registers no tasks, so it never touches
  // tasks.latest_code_version — the executors alone move that.
  const api = await startDaemon({ databaseUrl: s.db.url, port: PORT, reaperIntervalMs: 500 });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  const runStatus = async (id: string): Promise<RunStatus> => (await client.getRun(id)).status;

  /* -- deploy #1: trigger both runs and let them suspend ------------------- */
  let executor = spawnExecutor(V1_MODULE, 'deploy-v1');
  s.cleanup(() => executor.stop());

  await waitForTasks(s.pool, ['drift-strict', 'drift-lenient']);
  // Versions are per TASK, not per deploy (see code-version-pinning.ts for why:
  // a deploy-level version would let an edit to one task strand the in-flight
  // runs of every other). So the two tasks in this one process have two of them.
  const V1 = await readLatestCodeVersion(s.pool, 'drift-strict');
  const V1_LENIENT = await readLatestCodeVersion(s.pool, 'drift-lenient');
  s.assert(V1 !== null && V1_LENIENT !== null, 'deploy #1 should have registered code versions');
  s.ok(`deploy #1 up — drift-strict ${V1}, drift-lenient ${V1_LENIENT}`);

  const strictRun = await client.trigger('drift-strict', { user: 'u_42' });
  const lenientRun = await client.trigger('drift-lenient', { user: 'u_42' });
  s.log(`strict run:  ${strictRun.id}`);
  s.log(`lenient run: ${lenientRun.id}`);

  await waitFor(
    `both runs 'waiting' on the wait`,
    30_000,
    async () =>
      (await runStatus(strictRun.id)) === 'waiting' &&
      (await runStatus(lenientRun.id)) === 'waiting',
  );
  s.ok(`both runs suspended on ctx.wait.for("${WAIT_FOR}")`);

  /* -- ① code_version is stamped on the run at trigger time ---------------- */
  {
    const strict = await client.getRun(strictRun.id);
    const lenient = await client.getRun(lenientRun.id);
    s.assert(
      strict.codeVersion === V1 && lenient.codeVersion === V1_LENIENT,
      `runs.code_version should be stamped with each run's own task version ` +
        `('${V1}' / '${V1_LENIENT}') at trigger time, got ` +
        `'${strict.codeVersion}' / '${lenient.codeVersion}'`,
    );
    s.ok(`① runs.code_version stamped at trigger time (${V1} / ${V1_LENIENT})`);
  }

  // A deploy is a graceful stop (same choice as code-version-pinning.ts): the
  // SIGTERM marks the worker row offline immediately, which is what lets
  // deploy #2's registration through the C4 guard below. A SIGKILL would hold
  // the metadata for the 2-minute heartbeat window (the dead row still counts
  // as "served"), and the redeploy would be stalled until the offline marker
  // ages it out.
  await executor.stop();
  s.ok('deploy #1 stopped gracefully while both runs were waiting');

  // The API node is bookkeeping-only ({ waits: false, cron: false } — main.ts),
  // so with no executor alive nothing resumes the waits: the runs stay suspended
  // past their resume_at, and deploy #2 is what both wakes and replays them.
  await sleep(9_000); // > WAIT_FOR, so resume_at is comfortably in the past
  {
    const strict = await runStatus(strictRun.id);
    const lenient = await runStatus(lenientRun.id);
    s.assert(
      strict === 'waiting' && lenient === 'waiting',
      `with no executor alive both runs should still be 'waiting', got '${strict}' / '${lenient}'`,
    );
    s.ok(`both runs still 'waiting' past resume_at (API node resumes nothing)`);
  }

  /* -- deploy #2: same ids, one inserted step ------------------------------ */
  executor = spawnExecutor(V2_MODULE, 'deploy-v2');

  await waitFor('deploy #2 to register a new code version', 30_000, async () => {
    const v = await readLatestCodeVersion(s.pool, 'drift-strict');
    return v !== null && v !== V1;
  });
  const V2 = await readLatestCodeVersion(s.pool, 'drift-strict');
  s.ok(`② code version changed on a body-only edit: ${V1} → ${V2}`);
  s.ok('   (task ids and cron are byte-identical across the two deploys)');

  /* -- ③ strict: the drift is refused ------------------------------------- */
  {
    const result = await client.waitForResult(strictRun.id, undefined, { timeoutMs: 60_000 });
    s.assert(result.status === 'failed', `strict run should fail on drift, got '${result.status}'`);
    s.ok(`③ replay:'strict' failed the run instead of replaying a foreign step row`);

    s.assert(
      result.error?.name === 'AbortError',
      `drift failure should be an AbortError (non-retryable), got '${result.error?.name}'`,
    );
    const message = result.error?.message ?? '';
    s.assert(
      message.includes('replay drift at seq 1'),
      `error should name the drifting seq, got: ${message}`,
    );
    s.assert(
      message.includes(`kind 'wait' → 'step'`),
      `error should name the kind mismatch, got: ${message}`,
    );
    s.ok(`   error pinpoints the position: "replay drift at seq 1: kind 'wait' → 'step'"`);

    const detail = await client.getRunDetail(strictRun.id);
    s.assert(
      detail.run.attempt === 1,
      `an aborted drift must not retry; attempt should be 1, got ${detail.run.attempt}`,
    );
    s.ok('   no retry storm — attempt stayed 1 (AbortError is terminal)');

    s.assert(
      detail.run.codeVersion === V1,
      `the failed run should still carry its trigger-time version '${V1}', got '${detail.run.codeVersion}'`,
    );
    s.ok(`   post-mortem is answerable: run stamped ${V1}, executed by ${V2}`);

    // The refusal must leave the v1 ledger exactly as v1 wrote it: the point of
    // 'strict' is that nothing foreign lands, not merely that the run fails.
    await s.inv.assertSeqContiguous(strictRun.id, { kinds: ['step', 'wait'] });
    await s.inv.assertNoStepRewrites(strictRun.id);
    await s.inv.assertTerminalImmutable(strictRun.id);
    s.ok(`   the v1 ledger is untouched: still [step, wait], frozen and terminal`);
  }

  /* -- lenient: kind drift is refused here too ----------------------------- */
  {
    const result = await client.waitForResult(lenientRun.id, undefined, { timeoutMs: 60_000 });
    s.assert(
      result.status === 'failed',
      `lenient run should ALSO fail on kind drift, got '${result.status}'`,
    );
    s.ok(`lenient replay refused the same drift — both modes fail on kind drift`);

    s.assert(
      result.error?.name === 'AbortError',
      `lenient drift failure should be an AbortError (non-retryable), got '${result.error?.name}'`,
    );
    const message = result.error?.message ?? '';
    s.assert(
      message.includes('replay drift at seq 1'),
      `error should name the drifting seq, got: ${message}`,
    );
    s.assert(
      message.includes(`kind 'wait' → 'step'`),
      `error should name the kind mismatch, got: ${message}`,
    );
    s.ok(`   error pinpoints the position: "replay drift at seq 1: kind 'wait' → 'step'"`);

    const detail = await client.getRunDetail(lenientRun.id);
    s.assert(
      detail.run.attempt === 1,
      `an aborted drift must not retry; attempt should be 1, got ${detail.run.attempt}`,
    );
    s.ok('   no retry storm — attempt stayed 1 (AbortError is terminal)');

    s.assert(
      marker.count('audit:lenient') === 0,
      `the inserted step's body must never have run, got ${marker.count('audit:lenient')} marker lines`,
    );
    s.ok('   the inserted step "audit" never executed (its marker is absent)');

    s.assert(
      marker.count('load:lenient') === 1,
      'the agreeing prefix should still replay from cache exactly once',
    );
    s.ok('   the agreeing prefix (seq 0) still replayed from cache exactly once');

    // Even the failed run must satisfy the structural invariants — the drift is
    // a semantic hazard, not a broken ledger.
    await s.inv.assertSeqContiguous(lenientRun.id, { kinds: ['step', 'wait'] });
    await s.inv.assertNoStepRewrites(lenientRun.id);
    await s.inv.assertTerminalImmutable(lenientRun.id);
    s.ok('   the lenient ledger is still gap-free, append-only and frozen');
  }

  /* -- ④ rename + implementation edit: refused in BOTH modes --------------- */
  {
    // The fixture: v1 writes step "charge" at seq 1; v2 renames it "charge-v2"
    // AND rewrites the body. Same kind, so no kind drift — but the OLD label's
    // fingerprint (recomputed with today's call site) no longer matches what
    // v1 recorded, so the recorded output belongs to different code and BOTH
    // modes refuse it unconditionally (unlike a pure rename).
    let renameExecutor = spawnExecutor(RENAME_V1_MODULE, 'rename-v1');
    s.cleanup(() => renameExecutor.stop());

    await waitForTasks(s.pool, ['rename-strict', 'rename-lenient']);
    const RENAME_V1 = await readLatestCodeVersion(s.pool, 'rename-strict');
    s.assert(RENAME_V1 !== null, 'rename deploy #1 should have registered a code version');
    s.ok(`rename deploy #1 up — rename-strict ${RENAME_V1}`);

    const renameStrictRun = await client.trigger('rename-strict', { user: 'u_42' });
    const renameLenientRun = await client.trigger('rename-lenient', { user: 'u_42' });
    s.log(`rename-strict run:  ${renameStrictRun.id}`);
    s.log(`rename-lenient run: ${renameLenientRun.id}`);

    await waitFor(
      `both rename runs 'waiting' on the wait`,
      30_000,
      async () =>
        (await runStatus(renameStrictRun.id)) === 'waiting' &&
        (await runStatus(renameLenientRun.id)) === 'waiting',
    );
    s.ok(`both rename runs suspended on ctx.wait.for("${WAIT_FOR}")`);

    // A deploy is a graceful stop — same reasoning as the kind-drift swap above.
    await renameExecutor.stop();
    s.ok('rename deploy #1 stopped gracefully while both runs were waiting');

    // With no executor alive the runs stay suspended past resume_at; rename
    // deploy #2 is what both wakes and replays them.
    await sleep(9_000);
    renameExecutor = spawnExecutor(RENAME_V2_MODULE, 'rename-v2');

    await waitFor('rename deploy #2 to register a new code version', 30_000, async () => {
      const v = await readLatestCodeVersion(s.pool, 'rename-strict');
      return v !== null && v !== RENAME_V1;
    });
    const RENAME_V2 = await readLatestCodeVersion(s.pool, 'rename-strict');
    s.ok(`④ rename + implementation edit changed the version: ${RENAME_V1} → ${RENAME_V2}`);

    /* -- ④ rename-strict: the drift is refused --------------------------- */
    {
      const result = await client.waitForResult(renameStrictRun.id, undefined, {
        timeoutMs: 60_000,
      });
      s.assert(
        result.status === 'failed',
        `rename-strict should fail on label+code drift, got '${result.status}'`,
      );
      s.ok(`④ replay:'strict' failed the run instead of replaying a stale output`);

      s.assert(
        result.error?.name === 'AbortError',
        `rename-strict drift failure should be an AbortError (non-retryable), got '${result.error?.name}'`,
      );
      const message = result.error?.message ?? '';
      s.assert(
        message.includes('replay fingerprint mismatch at seq 1'),
        `error should name the seq and the mismatch, got: ${message}`,
      );
      s.assert(
        message.includes('"charge" → "charge-v2"'),
        `error should name the label drift, got: ${message}`,
      );
      s.ok(`   error pinpoints the position: "replay fingerprint mismatch at seq 1 (step "charge" → "charge-v2")"`);

      const detail = await client.getRunDetail(renameStrictRun.id);
      s.assert(
        detail.run.attempt === 1,
        `an aborted drift must not retry; attempt should be 1, got ${detail.run.attempt}`,
      );
      s.ok('   no retry storm — attempt stayed 1 (AbortError is terminal)');

      // The refusal must leave the v1 ledger exactly as v1 wrote it.
      await s.inv.assertSeqContiguous(renameStrictRun.id, { kinds: ['step', 'step', 'wait'] });
      await s.inv.assertNoStepRewrites(renameStrictRun.id);
      await s.inv.assertTerminalImmutable(renameStrictRun.id);
      s.ok('   the v1 ledger is untouched: still [step, step, wait], frozen and terminal');
    }

    /* -- ④ rename-lenient: the drift is refused here too ------------------ */
    {
      const result = await client.waitForResult(renameLenientRun.id, undefined, {
        timeoutMs: 60_000,
      });
      s.assert(
        result.status === 'failed',
        `rename-lenient should ALSO fail on label+code drift, got '${result.status}'`,
      );
      s.ok(`④ rename-lenient refused the same drift — both modes fail on a rename+rewrite`);

      s.assert(
        result.error?.name === 'AbortError',
        `rename-lenient drift failure should be an AbortError (non-retryable), got '${result.error?.name}'`,
      );
      const message = result.error?.message ?? '';
      s.assert(
        message.includes('replay fingerprint mismatch at seq 1'),
        `error should name the seq and the mismatch, got: ${message}`,
      );
      s.ok('   error pinpoints the position: "replay fingerprint mismatch at seq 1 (step "charge" → "charge-v2")"');

      const detail = await client.getRunDetail(renameLenientRun.id);
      s.assert(
        detail.run.attempt === 1,
        `an aborted drift must not retry; attempt should be 1, got ${detail.run.attempt}`,
      );
      s.ok('   no retry storm — attempt stayed 1 (AbortError is terminal)');
    }

    // The agreeing prefix replayed from cache exactly once, the v1 "charge"
    // body ran once per mode, and neither the renamed+rewritten "charge-v2"
    // body nor the never-reached "finish" ever ran.
    s.assert(
      marker.count('rename-load:strict') === 1 && marker.count('rename-load:lenient') === 1,
      'the agreeing prefix (seq 0) should still replay from cache exactly once',
    );
    s.assert(
      marker.count('charge:strict') === 1 && marker.count('charge:lenient') === 1,
      'the v1 "charge" body should have run exactly once per mode',
    );
    s.assert(
      marker.count('charge2:strict') === 0 && marker.count('charge2:lenient') === 0,
      'the renamed+rewritten "charge-v2" body must never run',
    );
    s.assert(
      marker.count('rename-finish:strict') === 0 && marker.count('rename-finish:lenient') === 0,
      'both runs aborted before "finish" — its body never ran',
    );
    s.ok('   marker probe: charge ran once per mode, charge-v2 never ran');
  }
}

await runScenario(
  {
    name: 'replay-drift',
    what: 'replay drift across code versions',
    db: { name: 'better_trigger_drift', envVar: 'BT_DRIFT_DB' },
  },
  main,
);
