/* =============================================================================
   @better-trigger/example-basic — code-version pinning acceptance scenario.

   replay-drift.ts proves the hazard: a task edited while runs are in flight
   hands the new code a ledger written by the old one, and `replay:'lenient'`
   (the default) completes the run reporting success for a step that never ran.
   This scenario proves the structural answer — `--pin-code-version` moves the
   decision from the executor, which can only react once it is already replaying
   a foreign row, to the CLAIM, which simply does not pick the run up:

     ① a run is stamped with its task's OWN version, not the deploy's, so an
        edit to one task leaves the other tasks' runs claimable;
     ② a pinned worker on the new build does not claim a run stamped with the
        old one — it stays queued, executing nothing, rather than drifting;
     ③ that wait is visible: the stranded scan reports it by task and version
        on /metrics, so "the queue stopped moving" has an answer;
     ④ a worker back on the original build claims it and replays it correctly.

   Same two task modules as replay-drift (v1 → v2 inserts a step at seq 1), so
   the two scenarios are the same edit with pinning off and on.

   Shape: an API node (no --tasks, so it claims nothing) serves HTTP and runs
   the stranded scan for the whole test; executor nodes are swapped under it.
   The v1 executor is stopped with SIGTERM rather than SIGKILL on purpose — a
   deploy is a graceful stop, and it is what marks the worker row offline
   immediately instead of two minutes later, which is when its version stops
   being "served" for the purposes of ③.

   Env:
     DATABASE_URL   base connection derived from it; default
                    postgres://localhost:5432/better_trigger
     BT_PIN_DB      database name prefix (default better_trigger_pin)
     BT_PIN_PORT    port the API node listens on (default 4905)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  freePort,
  createMarker,
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

// P2-35: freePort() default so parallel-ish runs and a lingering TIME_WAIT
// can't collide; BT_PIN_PORT override preserved for CI orchestration.
const PORT =
  process.env.BT_PIN_PORT !== undefined ? Number(process.env.BT_PIN_PORT) : await freePort();
const V1_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v1.ts', import.meta.url));
const V2_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v2.ts', import.meta.url));

/** Long enough to observe 'waiting' and swap deploys before it resumes. */
const WAIT_FOR = '6s';
/** How long "it stayed queued" is observed for before believing it. */
const HOLD_MS = 6_000;

/** One metric family's samples, parsed out of the exposition text. */
function samplesOf(text: string, name: string): Array<{ labels: string; value: number }> {
  const prefix = `better_trigger_${name}`;
  return text
    .split('\n')
    .filter((l) => l.startsWith(prefix) && !l.startsWith('#'))
    // `name{a="b"} 3` / `name 3` — the labels are whatever sits before the value.
    .map((l) => {
      const at = l.lastIndexOf(' ');
      const head = l.slice(0, at);
      return { labels: head.slice(prefix.length), value: Number(l.slice(at + 1)) };
    })
    .filter((s) => s.labels === '' || s.labels.startsWith('{'));
}

async function main(s: Scenario): Promise<void> {
  const marker = createMarker('bt-pin');
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

  // API node: HTTP + orchestrator + the stranded scan. It registers no tasks,
  // so it claims nothing and never moves tasks.latest_code_version; pinning on
  // it means the scan and nothing else.
  const api = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    reaperIntervalMs: 500,
    pinCodeVersion: true,
    strandedIntervalMs: 500,
  });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  const runStatus = async (id: string): Promise<RunStatus> => (await client.getRun(id)).status;
  const metrics = async (): Promise<string> =>
    await (await fetch(`${api.url}/api/v1/metrics`)).text();

  /* -- deploy #1: trigger a run and let it suspend on the wait ------------- */
  let executor = spawnExecutor(V1_MODULE, 'deploy-v1');
  s.cleanup(() => executor.stop());

  await waitForTasks(s.pool, ['drift-strict', 'drift-lenient']);
  const V1 = await readLatestCodeVersion(s.pool, 'drift-lenient');
  s.assert(V1 !== null, 'deploy #1 should have registered a code version');
  s.ok(`deploy #1 up — drift-lenient at ${V1}`);

  /* -- ① the version is the TASK's, not the deploy's ----------------------- */
  {
    const other = await readLatestCodeVersion(s.pool, 'drift-strict');
    s.assert(
      other !== null && other !== V1,
      `two tasks in one process must carry different versions ` +
        `(drift-strict '${other}' vs drift-lenient '${V1}') — a shared deploy-level ` +
        `version would let an edit to one strand the in-flight runs of the other`,
    );
    s.ok(`① per-task versions: drift-strict ${other}, drift-lenient ${V1}`);
  }

  // The lenient task is the interesting one: with pinning OFF it is the run
  // replay-drift.ts watches silently corrupt itself.
  const run = await client.trigger('drift-lenient', { user: 'u_42' });
  s.log(`run: ${run.id}`);

  await waitFor(`run 'waiting' on the wait`, 30_000, async () => (await runStatus(run.id)) === 'waiting');
  s.ok(`run suspended on ctx.wait.for("${WAIT_FOR}"), stamped ${V1}`);

  /* -- swap in deploy #2, which edited this task's body -------------------- */
  await executor.stop();
  s.ok('deploy #1 stopped gracefully (worker row offline, its version unserved)');

  executor = spawnExecutor(V2_MODULE, 'deploy-v2');
  await waitFor('deploy #2 to register a new code version', 30_000, async () => {
    const v = await readLatestCodeVersion(s.pool, 'drift-lenient');
    return v !== null && v !== V1;
  });
  const V2 = await readLatestCodeVersion(s.pool, 'drift-lenient');
  s.ok(`deploy #2 up — drift-lenient ${V1} → ${V2} (a step inserted at seq 1)`);

  /* -- ② the pinned worker resumes the wait but refuses the claim ---------- */
  await waitFor(
    `the wait to resume the run to 'queued'`,
    30_000,
    async () => (await runStatus(run.id)) === 'queued',
  );
  s.ok('deploy #2 resumed the wait — the run is queued and due');

  await sleep(HOLD_MS);
  {
    const status = await runStatus(run.id);
    s.assert(
      status === 'queued',
      `a run stamped '${V1}' must not be claimed by a worker serving '${V2}'; ` +
        `after ${HOLD_MS}ms it is '${status}'`,
    );
    // The decisive evidence: with pinning off this is exactly the run that
    // completes while the inserted step's body never executes.
    s.assert(
      marker.count('audit:lenient') === 0 && marker.count('finish:lenient') === 0,
      'nothing of the v2 body may have executed against the v1 ledger',
    );
    s.ok(`② the claim refused it: still queued after ${HOLD_MS}ms, nothing replayed`);
  }

  /* -- ③ waiting forever is not silent ------------------------------------- */
  {
    await waitFor('the stranded scan to report the run', 30_000, async () => {
      const [total] = samplesOf(await metrics(), 'stranded_runs');
      return (total?.value ?? 0) >= 1;
    });
    const text = await metrics();

    const [total] = samplesOf(text, 'stranded_runs');
    s.assertEqual(total?.value, 1, 'better_trigger_stranded_runs');

    const byVersion = samplesOf(text, 'stranded_runs_by_version');
    const mine = byVersion.find(
      (x) => x.labels.includes('task_id="drift-lenient"') && x.labels.includes(`code_version="${V1}"`),
    );
    s.assert(
      mine !== undefined && mine.value === 1,
      `the breakdown should name the build to bring back; got ${JSON.stringify(byVersion)}`,
    );
    s.ok(`③ stranded_runs 1, by_version{drift-lenient,${V1}} 1 — the wait is visible`);
  }

  /* -- ④ the build comes back and the run replays correctly ---------------- */
  await executor.stop();
  executor = spawnExecutor(V1_MODULE, 'deploy-v1-again');

  const result = await client.waitForResult(run.id, undefined, { timeoutMs: 60_000 });
  s.assert(
    result.status === 'completed',
    `a worker back on '${V1}' should claim and finish the run, got '${result.status}'`,
  );
  const output = result.output as Record<string, unknown>;
  s.assertEqual(output.deploy, 'v1', 'the run completed under the code that wrote its ledger');
  s.assertEqual(output.sentTo, 'u_42', 'the memoized step output survived the wait');
  s.assert(
    !('audit' in output),
    'the v2-only step must not appear in a run replayed by v1',
  );
  s.ok(`④ the run resumed on ${V1} and completed — no drift, no lost work`);

  // The prefix replayed from cache exactly once (the v1 executor that wrote it
  // is gone, so a second 'load' line would mean the step body re-ran) and the
  // tail ran exactly once.
  s.assertEqual(marker.count('load:lenient'), 1, "step 'load' bodies executed");
  s.assertEqual(marker.count('finish:lenient'), 1, "step 'finish' bodies executed");
  s.assertEqual(marker.count('audit:lenient'), 0, "step 'audit' bodies executed");

  // v1's shape, unchanged by the deploy that came and went: load, the wait it
  // suspended on, finish. An 'audit' row anywhere here would mean v2 got hold
  // of the ledger after all.
  await s.inv.assertSeqContiguous(run.id, { kinds: ['step', 'wait', 'step'] });
  await s.inv.assertNoStepRewrites(run.id);
  await s.inv.assertTerminalImmutable(run.id);
  s.ok('   the ledger is gap-free, append-only and frozen');

  /* -- and the scan goes quiet again --------------------------------------- */
  await waitFor('the stranded gauge to fall back to 0', 30_000, async () => {
    const [total] = samplesOf(await metrics(), 'stranded_runs');
    return total?.value === 0;
  });
  s.ok('stranded_runs back to 0 — the gauge recovers, it does not only ratchet');
}

await runScenario(
  {
    name: 'code-version-pinning',
    what: 'a pinned claim refuses runs it cannot replay, and says so',
    db: { name: 'better_trigger_pin', envVar: 'BT_PIN_DB' },
  },
  main,
);
