/* =============================================================================
   @better-trigger/worker — build metadata tests (O4).

   The whole point of the injected build-info module is that version and build
   cannot drift apart: BUILD_VERSION is read from apps/worker/package.json at
   build time (the same file that ships in the published tarball), and
   BUILD_SHA is the commit the build was made from. These tests pin the
   contract: the injected version always equals the package version, and the
   sha, when present, is a git short sha (with the -dirty marker when the
   build came from an uncommitted tree).

   resolveBuildSha (scripts/write-build-info.mjs) is exercised with injected
   env/git so the resolution order — trusted env, then git, then undefined —
   is pinned without touching the real repository.
   ============================================================================= */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_SHA, BUILD_VERSION } from '../src/generated/build-info';
import { resolveBuildSha } from '../scripts/write-build-info.mjs';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

describe('build metadata (O4)', () => {
  it('bakes the package version as the single version source', () => {
    // /health.version, the /metrics build_info label, the boot log and
    // workers.code_version all read BUILD_VERSION, which comes from the same
    // package.json that is packed and published — so the running artifact and
    // the registry artifact can never disagree on the version.
    expect(BUILD_VERSION).toBe(pkg.version);
    expect(BUILD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('carries a git short sha, or none outside a git checkout', () => {
    if (BUILD_SHA === undefined) return; // npm pack / Docker builds: version-only
    expect(BUILD_SHA).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
  });
});

describe('resolveBuildSha (write-build-info.mjs)', () => {
  it('prefers the trusted build env over git', () => {
    expect(
      resolveBuildSha({
        env: { BT_GIT_SHA: 'abc1234' },
        git: () => {
          throw new Error('git must not be consulted when env names the sha');
        },
      }),
    ).toBe('abc1234');
  });

  it('accepts GIT_SHA as the fallback env name', () => {
    expect(resolveBuildSha({ env: { GIT_SHA: 'deadbeef' }, git: () => 'wrong' })).toBe('deadbeef');
  });

  it('uses the git checkout when no env is set', () => {
    expect(resolveBuildSha({ env: {}, git: () => 'cafebabe' })).toBe('cafebabe');
  });

  it('degrades to undefined when neither env nor git is available', () => {
    // defaultGitSha catches its own failures (not a git checkout) and returns
    // undefined; this pins the caller side: undefined in, undefined out.
    expect(resolveBuildSha({ env: {}, git: () => undefined })).toBeUndefined();
  });

  it('trims whitespace so a blank env value falls through to git', () => {
    expect(
      resolveBuildSha({ env: { BT_GIT_SHA: '   ' }, git: () => 'abcdef0' }),
    ).toBe('abcdef0');
  });
});
