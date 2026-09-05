/* =============================================================================
   @better-trigger/example-basic — acceptance suite entry point.

   The harnesses in this directory (one per scenario; the suite header prints
   the live count) are the project's real correctness
   evidence (exactly-once steps under SIGKILL, fencing, replay drift, version
   pinning, rolling deploys, migration upgrades, worker loss, graceful
   restart, per-key concurrency limits, retention cascades, probe-pool
   behaviour on a live Postgres, orchestrator-loop self-healing under a
   statement timeout).
   Each one is a `runScenario()` call from @better-trigger/testing, so it
   already provisions its own database, spawns its own daemons, runs its own
   teardown and exits non-zero on any failed assertion — this script only runs
   them in sequence and folds their exit codes into one, so
   `bun run test:acceptance` (and CI) can gate on them.

   Kept as one child process per scenario on purpose: process isolation is what
   makes a scenario that SIGKILLs daemons (or leaks a listener on its port)
   unable to poison its neighbours, and what turns "the script crashed" into a
   non-zero exit code rather than a hung suite.

   They are deliberately run one at a time: each creates a unique scratch
   database and binds its own port, and several of them measure lease/reaper
   timing that a parallel neighbour would perturb.

   Usage:
     bun scripts/acceptance.ts                 # all harnesses
     bun scripts/acceptance.ts fencing crash   # only the named ones

   Env: everything the harnesses read (DATABASE_URL and their per-harness
   BT_*_DB / BT_*_PORT overrides) is inherited untouched — see each script's
   header. A live Postgres is required; this is NOT part of `bun run test`.
   ============================================================================= */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Harness {
  /** Selector used on the command line. */
  name: string;
  /** Script file in this directory. */
  file: string;
  /** One-line description, printed as the suite runs. */
  what: string;
}

/** Broadest first, so a wholesale breakage (or an unreachable Postgres) shows
 *  up before the slower fault-injection harnesses. */
const HARNESSES: Harness[] = [
  { name: 'e2e', file: 'e2e.ts', what: 'end-to-end smoke test over the HTTP client' },
  {
    name: 'embedded',
    file: 'embedded.ts',
    what: 'the same runtime runs in-process without a daemon or TCP listener',
  },
  { name: 'fencing', file: 'fencing.ts', what: 'fencing tokens reject late writes' },
  { name: 'replay-drift', file: 'replay-drift.ts', what: 'replay drift across code versions' },
  {
    name: 'code-version-pinning',
    file: 'code-version-pinning.ts',
    what: 'a pinned claim refuses runs it cannot replay, and says so',
  },
  {
    name: 'rolling-deploy',
    file: 'rolling-deploy.ts',
    what: 'two code versions overlap; each claims and drains its own runs',
  },
  {
    name: 'migration',
    file: 'migration.ts',
    what: '0007→latest upgrade preserves data and fires new constraints; old schema stays a subset',
  },
  {
    name: 'concurrency',
    file: 'concurrency.ts',
    what: 'per-key concurrency limits are enforced by the advisory lock',
  },
  { name: 'crash', file: 'crash.ts', what: 'steps stay exactly-once across SIGKILL' },
  { name: 'worker-lost', file: 'worker-lost.ts', what: 'expired leases are reclaimed' },
  {
    name: 'graceful-restart',
    file: 'graceful-restart.ts',
    what: 'a clean SIGTERM hands the claim back without spending an attempt',
  },
  {
    name: 'retention',
    file: 'retention.ts',
    what: 'prune deletes history through the foreign-key cascade',
  },
  {
    name: 'stats',
    file: 'stats.ts',
    what: 'task stats aggregate only the 24h window; lastRunAt stays all-history',
  },
  {
    name: 'run-detail',
    file: 'run-detail.ts',
    what: 'run detail serves one snapshot; newest-first logs page back via cursor (PF3)',
  },
  {
    name: 'notify',
    file: 'notify.ts',
    what: 'notification fast-path: claim wake, waiter registry, LISTEN loss, duplicate-safety',
  },
  {
    name: 'batch-perf',
    file: 'batch-perf.ts',
    what: '500-item batchTrigger is O(1) statements on a real Postgres; idempotency/cap/all-or-nothing intact (PF5)',
  },
  {
    name: 'constraints',
    file: 'constraints.ts',
    what: 'database-level FKs and CHECK constraints are enforced',
  },
  {
    name: 'health-pool',
    file: 'health-pool.ts',
    what: 'probe pool: statement_timeout server-side, 57014 cancellation, connection return, single-flight (PF4)',
  },
  {
    name: 'loop-hang',
    file: 'loop-hang.ts',
    what: 'a blocked scanWaits resume is cancelled by statement_timeout and the loop self-heals (p1-11)',
  },
];

interface Result {
  harness: Harness;
  code: number;
  ms: number;
}

/** Run one harness, inheriting stdio so its own ✓/✗ output stays live.
 *  Bounded by a per-harness timeout (default 5m, BT_ACCEPTANCE_TIMEOUT_MS to
 *  tune): a hung scenario kills its child and fails the suite NAMING the
 *  harness, instead of eating CI's whole job timeout with no pointer. */
function run(harness: Harness): Promise<number> {
  const script = fileURLToPath(new URL(`./${harness.file}`, import.meta.url));
  const timeoutMs = Number(process.env.BT_ACCEPTANCE_TIMEOUT_MS ?? 5 * 60_000);
  return new Promise((resolve) => {
    const proc = spawn('bun', [script], { stdio: 'inherit', env: process.env });
    const timer = setTimeout(() => {
      console.error(
        `\n✗ ${harness.name} exceeded ${timeoutMs}ms and was killed — the scenario hung. ` +
          `(raise BT_ACCEPTANCE_TIMEOUT_MS if it is merely slow)`,
      );
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      console.error(`\n✗ failed to spawn ${harness.file}: ${err.message}`);
      resolve(1);
    });
    // A harness killed by a signal has no exit code — count it as a failure.
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function selected(): Harness[] {
  const names = process.argv.slice(2);
  if (names.length === 0) return HARNESSES;
  return names.map((name) => {
    const harness = HARNESSES.find((h) => h.name === name);
    if (!harness) {
      console.error(
        `unknown harness "${name}" — known: ${HARNESSES.map((h) => h.name).join(', ')}`,
      );
      process.exit(2);
    }
    return harness;
  });
}

const suite = selected();
const results: Result[] = [];

console.log(`\nbetter-trigger acceptance — ${suite.length} harness(es)\n`);

for (const harness of suite) {
  console.log(`${'='.repeat(72)}\n▶ ${harness.name} — ${harness.what}\n`);
  const started = Date.now();
  const code = await run(harness);
  const ms = Date.now() - started;
  results.push({ harness, code, ms });
  console.log(`\n${code === 0 ? '✓' : '✗'} ${harness.name} (${(ms / 1000).toFixed(1)}s)`);
}

/* -- summary ---------------------------------------------------------------- */
const failed = results.filter((r) => r.code !== 0);
const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

console.log(`\n${'='.repeat(72)}\nacceptance summary  (${(totalMs / 1000).toFixed(1)}s)\n`);
for (const r of results) {
  const mark = r.code === 0 ? '✓' : `✗ (exit ${r.code})`;
  console.log(`  ${mark.padEnd(14)} ${r.harness.name.padEnd(14)} ${(r.ms / 1000).toFixed(1)}s`);
}

if (failed.length > 0) {
  console.log(`\n${failed.length}/${results.length} harness(es) failed.\n`);
  process.exit(1);
}
console.log(`\nAll ${results.length} harness(es) passed.\n`);
process.exit(0);
