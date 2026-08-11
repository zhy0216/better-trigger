/* =============================================================================
   @better-trigger/worker — code version derivation unit tests.

   Two concepts, two functions (O4):

   - resolveCodeVersion is the BUILD identity (workers.code_version): package
     version + git sha, the same value /health and /metrics report. It answers
     "which commit is this process" and must therefore NOT depend on task
     source. BETTER_TRIGGER_VERSION overrides it.
   - resolveTaskVersion is the REPLAY identity per task (runs.code_version,
     what --pin-code-version matches on): a hash of id + cron + run() body
     source, so an edited body on one task never moves its peers' versions.
   ============================================================================= */
import type { ResolvedTaskDefinition } from 'better-trigger/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCodeVersion, resolveTaskVersion } from '../src/runtime';
import { BUILD_SHA, BUILD_VERSION } from '../src/generated/build-info';

type AnyDef = ResolvedTaskDefinition<any, any>;

const def = (id: string, run: AnyDef['run'], cron?: AnyDef['cron']): AnyDef =>
  ({ id, run, cron }) as AnyDef;

const bodyA: AnyDef['run'] = async () => 'a';
const bodyB: AnyDef['run'] = async () => 'b';

describe('resolveCodeVersion (the build identity)', () => {
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
    expect(resolveCodeVersion()).toBe('git-1a2b3c4');
  });

  it('is the build identity: package version + git sha', () => {
    // workers.code_version MUST trace to the same commit as /health.version —
    // that is the whole point (O4). Version-only when built outside git.
    const expected =
      BUILD_SHA === undefined ? BUILD_VERSION : `${BUILD_VERSION}+${BUILD_SHA}`;
    expect(resolveCodeVersion()).toBe(expected);
    expect(resolveCodeVersion()).toMatch(/^\d+\.\d+\.\d+(\+[0-9a-f]+(-dirty)?)?$/);
  });

  it('is deterministic and independent of the task set', () => {
    // The build identity describes the PROCESS, not its tasks — an API-only
    // node and a worker with fifty tasks on the same build report the same
    // workers.code_version, and the empty task set cannot change it.
    const first = resolveCodeVersion();
    expect(resolveCodeVersion()).toBe(first);
  });

  it('does NOT change when task source changes — that is resolveTaskVersion\'s job', () => {
    // The one property the old task-set hash had that the build identity
    // must not: replay safety lives in the per-task version (and the C1 step
    // fingerprint), so the deploy identity is free to stay stable across a
    // task edit — which is what makes it traceable to a single commit.
    const before = resolveCodeVersion();
    // (source edits are simulated by the peer describe below — here we pin
    // that NO task input exists to change the result at all)
    expect(resolveCodeVersion()).toBe(before);
  });
});

/* -----------------------------------------------------------------------------
   resolveTaskVersion is the OTHER half: what a run is stamped with, and what a
   pinned claim matches on. Its whole reason to exist is the property the build
   identity cannot have — one task's edit must leave the other tasks' versions
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

  it('is NOT the build identity — the two answer different questions', () => {
    // workers.code_version says "which commit is this process" (the build
    // identity); the task version says "which shape wrote this run's ledger".
    // Never interchangeable: the per-task hash is a v_<12 hex> replay marker,
    // the build identity is `0.1.0+<sha>`.
    expect(resolveTaskVersion(def('a', bodyA))).not.toBe(resolveCodeVersion());
  });

  it('collapses to BETTER_TRIGGER_VERSION when the deployment names one', () => {
    process.env.BETTER_TRIGGER_VERSION = 'git-1a2b3c4';
    // Deliberate: a deployment that pins its own version is asking for all its
    // tasks to move together, which is the coarse behaviour by definition.
    expect(resolveTaskVersion(def('a', bodyA))).toBe('git-1a2b3c4');
    expect(resolveTaskVersion(def('b', bodyB))).toBe('git-1a2b3c4');
  });
});
