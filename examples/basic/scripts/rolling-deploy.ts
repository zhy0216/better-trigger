/* =============================================================================
   @better-trigger/example-basic — rolling-deploy acceptance scenario (O5,
   todos/03-operability.md).

   code-version-pinning.ts proves a pinned worker refuses foreign ledgers, but
   it swaps deploys one at a time. A ROLLING deploy keeps the old and the new
   build serving the same database at the same time — the overlap is the whole
   point. Under the C4 registration guard (the stored code version is only
   overwritten when no online worker still serves it), the overlap semantics
   are:

     ① an executor on deploy #1 (v1 task body) takes a run and suspends it on
        a wait — its ledger is stamped v1;
     ② deploy #2 (v2 task body) joins WITHOUT deploy #1 stopping: two workers
        with different per-task code versions are online against one database
        at the same moment, and the shared `latest_code_version` does NOT
        churn — that is the C4 guard, and it is what makes the overlap safe:
        metadata stays put while the old build still serves;
     ③ a run triggered during the overlap is stamped with the still-live v1
        and executes the v1 body end to end on deploy #1 — no drift, no
        re-executed steps, no version flip-flop;
     ④ the v1-stamped suspended run resumes and drains on deploy #1, with the
        v1 output and the memoized step surviving the wait;
     ⑤ with every stamped version still served, the stranded scan reports
        nothing, and both ledgers are gap-free / append-only / frozen;
     ⑥ the old build then leaves gracefully (the rolling-deploy exit: it
        stops AFTER its runs drain). The pinning trade now shows up
        deterministically: a run triggered after deploy #1 is gone is still
        stamped v1 — the metadata cannot re-register by itself — deploy #2
        refuses the foreign stamp, the run stays queued, and the stranded
        gauge names the build that has to come back (or be re-deployed);
     ⑦ the takeover completes the story: a FRESH boot of the new build
        re-registers, the C4 guard now lets the version through (nothing
        online serves v1 anymore), the stranded run is canceled (the operator
        action the gauge prescribes), stranded falls back to 0, and a new run
        is stamped v2 and executes the v2 body end to end — the rolling
        deploy fully switched over.

   Same task modules as replay-drift (v1 = load/wait/finish, v2 inserts a
   `ctx.step("audit")` between load and the wait), same pinning flag, so the
   three scenarios form a ladder: drift OFF, pinning without overlap, pinning
   WITH overlap.

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_ROLL_DB        override the provisioned database name (default
                       better_trigger_roll)
     BT_ROLL_PORT      port the API node listens on (default 4911)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  createMarker,
  portFromEnv,
  readLatestCodeVersion,
  runScenario,
  sleep,
  waitFor,
  waitForTasks,
  spawnDaemon,
  startDaemon,
  type Daemon,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';

const PORT = portFromEnv('BT_ROLL_PORT', 4911);
const V1_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v1.ts', import.meta.url));
const V2_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v2.ts', import.meta.url));

const WAIT_FOR = '6s';
const HOLD_MS = 5_000;

/** The stranded-runs total gauge from a metrics scrape. */
async function strandedTotal(url: string): Promise<number> {
  const text = await (await fetch(`${url}/api/v1/metrics`)).text();
  const line = text
    .split('\n')
    .find((l) => l.startsWith('better_trigger_stranded_runs ') && !l.startsWith('#'));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : -1;
}

interface WorkerRow {
  name: string;
  status: string;
  code_version: string;
  tasks: Array<{ id: string; codeVersion: string }>;
}

async function main(s: Scenario): Promise<void> {
  const marker = createMarker('bt-roll');
  s.log(`marker ${marker.file}`);

  const spawnExecutor = (tasksModule: string, label: string): Daemon =>
    spawnDaemon({
      databaseUrl: s.db.url,
      tasks: tasksModule,
      serve: false,
      concurrency: 2,
      name: label,
      pinCodeVersion: true,
      env: { ...marker.env, BT_DRIFT_WAIT: WAIT_FOR },
    });

  // API node: HTTP + orchestrator loops + the stranded scan; registers no
  // tasks, so it claims nothing and never moves latest_code_version.
  const api = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    reaperIntervalMs: 500,
    pinCodeVersion: true,
    strandedIntervalMs: 500,
  });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  const readWorkers = async (): Promise<WorkerRow[]> => {
    const res = await s.pool.query<WorkerRow>(
      `SELECT name, status, code_version, tasks FROM workers
       WHERE name IN ('deploy-v1', 'deploy-v2') ORDER BY name`,
    );
    return res.rows;
  };

  /* -- ① deploy #1 serves and suspends a run on its wait ------------------ */
  const executorV1 = spawnExecutor(V1_MODULE, 'deploy-v1');
  s.cleanup(() => executorV1.stop());

  await waitForTasks(s.pool, ['drift-strict', 'drift-lenient']);
  const V1 = await readLatestCodeVersion(s.pool, 'drift-lenient');
  s.assert(V1 !== null, 'deploy #1 should have registered a code version');
  s.ok(`deploy #1 up — drift-lenient at ${V1}`);

  const oldRun = await client.trigger('drift-lenient', { user: 'u_42' });
  s.log(`run (v1 ledger): ${oldRun.id}`);

  await waitFor('the run to suspend on its wait', 30_000, async () => {
    return (await client.getRun(oldRun.id)).status === 'waiting';
  });
  s.ok(`old run suspended on ctx.wait.for("${WAIT_FOR}"), stamped ${V1}`);

  /* -- ② deploy #2 joins WITHOUT deploy #1 leaving ------------------------ */
  const executorV2 = spawnExecutor(V2_MODULE, 'deploy-v2');
  s.cleanup(() => executorV2.stop());

  await waitFor('deploy #2 to come online', 30_000, async () => {
    const rows = await readWorkers();
    return rows.some((r) => r.name === 'deploy-v2' && r.status === 'online');
  });

  // Deploy #2's own per-task version, read off its worker row — the value the
  // takeover waits for at ⑥.
  let V2: string;
  {
    const rows = await readWorkers();
    const v1TaskVersion = rows
      .find((r) => r.name === 'deploy-v1')
      ?.tasks.find((t) => t.id === 'drift-lenient')?.codeVersion;
    V2 = rows
      .find((r) => r.name === 'deploy-v2')
      ?.tasks.find((t) => t.id === 'drift-lenient')?.codeVersion as string;
    s.assert(
      rows.every((r) => r.status === 'online'),
      `both builds must be online during the overlap; got ${JSON.stringify(rows)}`,
    );
    s.assert(
      v1TaskVersion === V1 && V2 !== undefined && V2 !== V1,
      `the two daemons must serve different per-task versions ` +
        `(v1 '${v1TaskVersion}' vs v2 '${V2}')`,
    );
    s.assertEqual(
      await readLatestCodeVersion(s.pool, 'drift-lenient'),
      V1,
      'the shared latest_code_version must NOT churn while the old build still serves (C4)',
    );
    s.ok('① overlap: two builds online, per-task versions differ, metadata stable');
  }

  /* -- ③ a run triggered mid-overlap executes the v1 body on deploy #1 --- */
  const overlapRun = await client.trigger('drift-lenient', { user: 'u_7' });
  s.log(`run during overlap: ${overlapRun.id}`);

  const overlapResult = await client.waitForResult(overlapRun.id, undefined, { timeoutMs: 60_000 });
  s.assert(
    overlapResult.status === 'completed',
    `the overlap run should complete, got '${overlapResult.status}'`,
  );
  const overlapOutput = overlapResult.output as Record<string, unknown>;
  s.assertEqual(overlapOutput.deploy, 'v1', 'the overlap run executed the still-live v1 body');
  s.assertEqual(overlapOutput.sentTo, 'u_7', 'step output intact');
  s.assert(!('audit' in overlapOutput), 'the v2-only step must not appear in a v1-ledger run');
  s.ok(`② overlap run completed under deploy #1 — no version flip-flop, no drift`);

  /* -- ④ the suspended run drains on deploy #1 --------------------------- */
  const oldResult = await client.waitForResult(oldRun.id, undefined, { timeoutMs: 60_000 });
  s.assert(
    oldResult.status === 'completed',
    `the old run should drain on deploy #1, got '${oldResult.status}'`,
  );
  const oldOutput = oldResult.output as Record<string, unknown>;
  s.assertEqual(oldOutput.deploy, 'v1', 'the old run completed under the code that wrote its ledger');
  s.assertEqual(oldOutput.sentTo, 'u_42', 'the memoized step output survived the wait');
  s.assert(!('audit' in oldOutput), 'the v2-only step must not appear in a v1-ledger run');

  // Each run's steps executed exactly once across the whole overlap — the
  // v2 body never ran anything.
  s.assertEqual(marker.count('load:lenient'), 2, "step 'load' bodies executed (one per run)");
  s.assertEqual(marker.count('finish:lenient'), 2, "step 'finish' bodies executed");
  s.assertEqual(marker.count('audit:lenient'), 0, "step 'audit' bodies executed (none)");

  await s.inv.assertSeqContiguous(oldRun.id, { kinds: ['step', 'wait', 'step'] });
  await s.inv.assertSeqContiguous(overlapRun.id, { kinds: ['step', 'wait', 'step'] });
  for (const id of [oldRun.id, overlapRun.id]) {
    await s.inv.assertNoStepRewrites(id);
    await s.inv.assertTerminalImmutable(id);
  }
  s.ok('③ both ledgers gap-free, append-only and frozen');

  /* -- ⑤ every stamped version is served: nothing stranded during overlap - */
  await waitFor('the stranded gauge to stay at 0', 15_000, async () => {
    return (await strandedTotal(api.url!)) === 0;
  });
  s.ok('④ stranded_runs 0 throughout the overlap — no run waits for a build that left');

  /* -- ⑥ the old build leaves; the C4 guard holds, then the takeover -------- */
  await executorV1.stop();
  await waitFor('deploy #1 to be marked offline', 30_000, async () => {
    const rows = await readWorkers();
    return rows.find((r) => r.name === 'deploy-v1')?.status === 'offline';
  });
  s.ok('deploy #1 stopped gracefully after its runs drained (the rolling-deploy exit)');

  const orphaned = await client.trigger('drift-lenient', { user: 'u_9' });
  s.log(`run after deploy #1 left: ${orphaned.id}`);

  await waitFor('the orphaned run to be reported stranded', 30_000, async () => {
    return (await strandedTotal(api.url!)) >= 1;
  });
  await sleep(HOLD_MS);
  {
    const status = (await client.getRun(orphaned.id)).status;
    s.assert(
      status === 'queued',
      `a run stamped '${V1}' must not be claimed by the v2-only worker; ` +
        `after ${HOLD_MS}ms it is '${status}'`,
    );
    s.assert(
      marker.count('load:lenient') === 2,
      'nothing of the orphaned run may have executed',
    );
    s.ok(`⑤ the orphaned run waits: stranded 1, no v2 claim, nothing executed`);
  }

  // The takeover: a FRESH boot of the new build re-registers, and with deploy
  // #1's row offline the C4 guard lets the version through. (Deploy #2's
  // original daemon never re-registers on its own — the metadata only moves
  // when something registers — so a rolling deploy hands over when the new
  // build's next instance boots, exactly as an operator would restart it.)
  const restart = spawnExecutor(V2_MODULE, 'deploy-v2-restart');
  s.cleanup(() => restart.stop());

  await waitFor('the shared version to flip to deploy #2 after the old build left', 30_000, async () => {
    return (await readLatestCodeVersion(s.pool, 'drift-lenient')) === V2;
  });
  s.ok(`⑥ takeover: deploy #2's version is live (${V1} → ${V2}) once nothing serves the old one`);

  // The stranded backlog is cleared the way the gauge tells the operator to:
  // cancel the runs pinned to the build that left (they cannot be replayed).
  await client.cancelRun(orphaned.id);
  await waitFor('the stranded gauge to fall back to 0', 30_000, async () => {
    return (await strandedTotal(api.url!)) === 0;
  });
  s.ok('   the orphaned run was canceled — stranded back to 0');

  // New work now flows on the new build end to end.
  const takeoverRun = await client.trigger('drift-lenient', { user: 'u_11' });
  const takeoverResult = await client.waitForResult(takeoverRun.id, undefined, { timeoutMs: 60_000 });
  s.assert(
    takeoverResult.status === 'completed',
    `the post-takeover run should complete, got '${takeoverResult.status}'`,
  );
  const takeoverOutput = takeoverResult.output as Record<string, unknown>;
  s.assertEqual(takeoverOutput.deploy, 'v2', 'the post-takeover run executed the v2 body');
  s.assertEqual(takeoverOutput.sentTo, 'u_11', 'step output intact');
  s.assert(
    (takeoverOutput.audit as { audited?: boolean })?.audited === true,
    'the v2-only audit step executed on the post-takeover run',
  );
  s.assertEqual(marker.count('load:lenient'), 3, "step 'load' bodies executed (R1+R2+takeover)");
  s.assertEqual(marker.count('finish:lenient'), 3, "step 'finish' bodies executed");
  s.assertEqual(marker.count('audit:lenient'), 1, "step 'audit' bodies executed (takeover run only)");
  await s.inv.assertSeqContiguous(takeoverRun.id, { kinds: ['step', 'step', 'wait', 'step'] });
  await s.inv.assertNoStepRewrites(takeoverRun.id);
  await s.inv.assertTerminalImmutable(takeoverRun.id);
  s.ok(`⑦ the takeover run drained on deploy #2 — the rolling deploy fully switched over`);
}

await runScenario(
  {
    name: 'rolling-deploy',
    what: 'old and new builds overlap safely; the old drains its runs, then the pinning trade shows',
    db: { name: 'better_trigger_roll', envVar: 'BT_ROLL_DB' },
  },
  main,
);
