/* =============================================================================
   @better-trigger/example-basic — acceptance suite entry point.

   The six scenarios in this directory are the project's real correctness
   evidence (exactly-once steps under SIGKILL, fencing, replay drift, worker
   loss, graceful restart). Each one is a `runScenario()` call from
   @better-trigger/testing, so it
   already provisions its own database, spawns its own daemons, runs its own
   teardown and exits non-zero on any failed assertion — this script only runs
   them in sequence and folds their exit codes into one, so
   `bun run test:acceptance` (and CI) can gate on them.

   Kept as one child process per scenario on purpose: process isolation is what
   makes a scenario that SIGKILLs daemons (or leaks a listener on its port)
   unable to poison its neighbours, and what turns "the script crashed" into a
   non-zero exit code rather than a hung suite.

   They are deliberately run one at a time: each drops and recreates its own
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
  { name: 'fencing', file: 'fencing.ts', what: 'fencing tokens reject late writes' },
  { name: 'replay-drift', file: 'replay-drift.ts', what: 'replay drift across code versions' },
  { name: 'crash', file: 'crash.ts', what: 'steps stay exactly-once across SIGKILL' },
  { name: 'worker-lost', file: 'worker-lost.ts', what: 'expired leases are reclaimed' },
  {
    name: 'graceful-restart',
    file: 'graceful-restart.ts',
    what: 'a clean SIGTERM hands the claim back without spending an attempt',
  },
];

interface Result {
  harness: Harness;
  code: number;
  ms: number;
}

/** Run one harness, inheriting stdio so its own ✓/✗ output stays live. */
function run(harness: Harness): Promise<number> {
  const script = fileURLToPath(new URL(`./${harness.file}`, import.meta.url));
  return new Promise((resolve) => {
    const proc = spawn('bun', [script], { stdio: 'inherit', env: process.env });
    proc.on('error', (err) => {
      console.error(`\n✗ failed to spawn ${harness.file}: ${err.message}`);
      resolve(1);
    });
    // A harness killed by a signal has no exit code — count it as a failure.
    proc.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
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
