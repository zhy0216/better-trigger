/* =============================================================================
   @better-trigger/worker — code version derivation unit tests.

   resolveCodeVersion is what stamps runs.code_version / workers.code_version, so
   its contract has two halves worth pinning: identical task source on two
   processes must agree (or every worker looks like a new deploy), and an edited
   run() body must NOT agree (that is exactly the change that can invalidate an
   in-flight replay ledger). BETTER_TRIGGER_VERSION overrides both.
   ============================================================================= */
import type { ResolvedTaskDefinition } from 'better-trigger/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCodeVersion, resolveTaskVersion } from '../src/runtime';

type AnyDef = ResolvedTaskDefinition<any, any>;

const def = (id: string, run: AnyDef['run'], cron?: AnyDef['cron']): AnyDef =>
  ({ id, run, cron }) as AnyDef;

const bodyA: AnyDef['run'] = async () => 'a';
const bodyB: AnyDef['run'] = async () => 'b';

describe('resolveCodeVersion', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BETTER_TRIGGER_VERSION;
    delete process.env.BETTER_TRIGGER_VERSION;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_TRIGGER_VERSION;
    else process.env.BETTER_TRIGGER_VERSION = saved;
  });

  it('returns BETTER_TRIGGER_VERSION verbatim when it is set', () => {
    process.env.BETTER_TRIGGER_VERSION = 'git-1a2b3c4';
    expect(resolveCodeVersion([def('a', bodyA)])).toBe('git-1a2b3c4');
    // ...even for a task set that would otherwise hash to something else.
    expect(resolveCodeVersion([def('b', bodyB)])).toBe('git-1a2b3c4');
  });

  it('derives a v_<12 hex> version from the task set', () => {
    expect(resolveCodeVersion([def('a', bodyA)])).toMatch(/^v_[0-9a-f]{12}$/);
    expect(resolveCodeVersion([])).toMatch(/^v_[0-9a-f]{12}$/);
  });

  it('is deterministic and independent of definition order', () => {
    const one = resolveCodeVersion([def('a', bodyA), def('b', bodyB)]);
    const again = resolveCodeVersion([def('a', bodyA), def('b', bodyB)]);
    const reversed = resolveCodeVersion([def('b', bodyB), def('a', bodyA)]);
    expect(again).toBe(one);
    expect(reversed).toBe(one);
  });

  it('changes when a run body changes', () => {
    const before = resolveCodeVersion([def('a', async () => 'step-1')]);
    const after = resolveCodeVersion([def('a', async () => 'step-1; step-2')]);
    expect(after).not.toBe(before);
  });

  it('changes when the task set or an id changes', () => {
    const one = resolveCodeVersion([def('a', bodyA)]);
    expect(resolveCodeVersion([def('renamed', bodyA)])).not.toBe(one);
    expect(resolveCodeVersion([def('a', bodyA), def('b', bodyB)])).not.toBe(one);
  });

  it('changes when cron pattern or timezone changes', () => {
    const none = resolveCodeVersion([def('a', bodyA)]);
    const daily = resolveCodeVersion([def('a', bodyA, { pattern: '0 9 * * *' })]);
    const zoned = resolveCodeVersion([
      def('a', bodyA, { pattern: '0 9 * * *', timezone: 'Asia/Shanghai' }),
    ]);
    expect(daily).not.toBe(none);
    expect(zoned).not.toBe(daily);
  });

  it('hashes source text, so two identical bodies collide by design', () => {
    // Documented caveat: the fingerprint is Function.prototype.toString, not
    // semantics — same text means same version even for distinct closures.
    const first = resolveCodeVersion([def('a', async () => 'same')]);
    const second = resolveCodeVersion([def('a', async () => 'same')]);
    expect(second).toBe(first);
  });
});

/* -----------------------------------------------------------------------------
   resolveTaskVersion is the OTHER half: what a run is stamped with, and what a
   pinned claim matches on. Its whole reason to exist is the property the deploy
   version cannot have — one task's edit must leave the other tasks' versions
   alone, or pinning would freeze in-flight runs nobody touched.
   -------------------------------------------------------------------------- */
describe('resolveTaskVersion', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BETTER_TRIGGER_VERSION;
    delete process.env.BETTER_TRIGGER_VERSION;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_TRIGGER_VERSION;
    else process.env.BETTER_TRIGGER_VERSION = saved;
  });

  it('is independent of the other tasks in the process', () => {
    const alone = resolveTaskVersion(def('a', bodyA));
    // b changed, was added, was removed — none of it may move a's version.
    expect(resolveTaskVersion(def('a', bodyA))).toBe(alone);
    const withPeers = [def('a', bodyA), def('b', bodyB)].map(resolveTaskVersion);
    expect(withPeers[0]).toBe(alone);
    expect(withPeers[1]).not.toBe(alone);
  });

  it('changes when that task\'s own body, id or cron changes', () => {
    const base = resolveTaskVersion(def('a', bodyA));
    expect(resolveTaskVersion(def('a', bodyB))).not.toBe(base);
    expect(resolveTaskVersion(def('renamed', bodyA))).not.toBe(base);
    expect(resolveTaskVersion(def('a', bodyA, { pattern: '0 9 * * *' }))).not.toBe(base);
  });

  it('derives a v_<12 hex> version', () => {
    expect(resolveTaskVersion(def('a', bodyA))).toMatch(/^v_[0-9a-f]{12}$/);
  });

  it('is NOT the deploy version — the two answer different questions', () => {
    // workers.code_version says "which build is this process"; the task version
    // says "which shape wrote this run's ledger". Same ingredients, different
    // scope, and nothing should start treating them as interchangeable.
    const defs = [def('a', bodyA), def('b', bodyB)];
    expect(resolveTaskVersion(defs[0]!)).not.toBe(resolveCodeVersion(defs));
  });

  it('collapses to BETTER_TRIGGER_VERSION when the deployment names one', () => {
    process.env.BETTER_TRIGGER_VERSION = 'git-1a2b3c4';
    // Deliberate: a deployment that pins its own version is asking for all its
    // tasks to move together, which is the coarse behaviour by definition.
    expect(resolveTaskVersion(def('a', bodyA))).toBe('git-1a2b3c4');
    expect(resolveTaskVersion(def('b', bodyB))).toBe('git-1a2b3c4');
  });
});
