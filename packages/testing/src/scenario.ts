/* =============================================================================
   @better-trigger/testing — scenario runner.

   One acceptance scenario = one bun process = one call to runScenario(). It
   owns the parts every scenario used to hand-roll:

     - provisions the scenario's database (resetDb) and hands over pool +
       invariant assertions;
     - collects ✓ / ✗ lines and prints the summary;
     - runs teardown (LIFO, each guarded) even when the body throws;
     - exits non-zero on ANY failure — the property scripts/acceptance.ts and CI
       depend on. No helper in this package calls process.exit() on a failed
       assertion; failures travel as exceptions so teardown still runs.

   Two assertion styles are supported, matching what the scenarios need:
     s.assert / s.ok   linear, fail-fast — a crash scenario cannot meaningfully
                       continue past a broken step;
     s.check(name, fn) soft — records the failure and keeps going, so one run of
                       the e2e suite reports every broken check at once.
   ============================================================================= */
import type { Pool } from 'pg';
import {
  assert as bareAssert,
  assertEqual as bareAssertEqual,
  describeError,
} from './assert';
import { resetDb, type ResetDbOptions, type TestDatabase } from './database';
import { createInvariants, type Invariants } from './invariants';

export interface ScenarioMeta {
  /** Selector-ish short name, e.g. 'crash'. Used in the header + summary. */
  name: string;
  /** One-line description of what the scenario proves. */
  what?: string;
  /** The database this scenario provisions for itself. */
  db: ResetDbOptions;
}

export interface Scenario {
  /** The provisioned database (name / url / pool / drop). */
  db: TestDatabase;
  /** Shorthand for `db.pool`. */
  pool: Pool;
  /** Invariant assertions bound to this scenario's pool. */
  inv: Invariants;

  /** Record a passing check. */
  ok(msg: string): void;
  /** Print an informational line (run ids, urls) without counting a check. */
  log(msg: string): void;
  /** Fail the scenario immediately. */
  fail(msg: string): never;
  assert(cond: unknown, msg: string): asserts cond;
  assertEqual(actual: unknown, expected: unknown, label: string): void;
  /** Soft check: records ✓/✗ with elapsed ms and keeps going on failure. */
  check(name: string, fn: () => Promise<void>): Promise<void>;
  /** Register teardown; runs LIFO after the body, pass or fail. */
  cleanup(fn: () => Promise<void> | void): void;
}

class ScenarioImpl implements Scenario {
  passed = 0;
  readonly failures: string[] = [];
  private readonly teardown: Array<() => Promise<void> | void> = [];

  constructor(
    readonly db: TestDatabase,
    readonly inv: Invariants,
  ) {}

  get pool(): Pool {
    return this.db.pool;
  }

  ok(msg: string): void {
    this.passed += 1;
    console.log(`  ✓ ${msg}`);
  }

  log(msg: string): void {
    console.log(`  ${msg}`);
  }

  fail(msg: string): never {
    bareAssert(false, msg);
    throw new Error('unreachable');
  }

  assert(cond: unknown, msg: string): asserts cond {
    bareAssert(cond, msg);
  }

  assertEqual(actual: unknown, expected: unknown, label: string): void {
    bareAssertEqual(actual, expected, label);
  }

  async check(name: string, fn: () => Promise<void>): Promise<void> {
    const t0 = Date.now();
    try {
      await fn();
      this.passed += 1;
      console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
      const msg = describeError(err);
      this.failures.push(`${name}: ${msg}`);
      console.log(`  ✗ ${name} (${Date.now() - t0}ms)\n      ${msg}`);
    }
  }

  cleanup(fn: () => Promise<void> | void): void {
    this.teardown.push(fn);
  }

  /** LIFO, each guarded: a broken teardown must not mask the real failure. */
  async runTeardown(): Promise<void> {
    for (const fn of [...this.teardown].reverse()) {
      try {
        await fn();
      } catch (err) {
        console.warn(`  ! teardown step failed: ${describeError(err)}`);
      }
    }
  }
}

/**
 * Run one acceptance scenario end to end and exit with its verdict (0 all
 * passed / 1 anything failed). Never returns.
 */
export async function runScenario(
  meta: ScenarioMeta,
  body: (s: Scenario) => Promise<void>,
): Promise<never> {
  const started = Date.now();
  console.log(`\nbetter-trigger ${meta.name}${meta.what ? ` — ${meta.what}` : ''}`);

  let db: TestDatabase;
  try {
    db = await resetDb(meta.db);
  } catch (err) {
    // Unreachable Postgres lands here — it must still be a non-zero exit.
    console.error(`\n✗ ${meta.name}: could not provision the database — ${describeError(err)}\n`);
    process.exit(1);
  }

  const s = new ScenarioImpl(db, createInvariants(db.pool));
  s.log(`db ${db.url}`);
  // Registered first → runs last: everything else may still need the pool.
  s.cleanup(() => db.end());

  let crash: unknown = null;
  try {
    await body(s);
  } catch (err) {
    crash = err;
  }
  await s.runTeardown();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${'-'.repeat(48)}`);
  const failed = s.failures.length + (crash ? 1 : 0);
  console.log(`  ${s.passed} passed, ${failed} failed  (${elapsed}s)`);

  if (failed === 0) {
    console.log(`\nAll ${s.passed} ${meta.name} checks passed.\n`);
    process.exit(0);
  }

  console.log('\nFailures:');
  for (const f of s.failures) console.log(`  ✗ ${f}`);
  if (crash) {
    console.log(`  ✗ ${describeError(crash)}`);
    if (crash instanceof Error && crash.name !== 'AssertionFailure') {
      console.error(crash);
    }
  }
  console.log('');
  process.exit(1);
}
