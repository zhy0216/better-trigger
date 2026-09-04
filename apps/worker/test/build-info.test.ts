/* =============================================================================
   @better-trigger/worker — build metadata tests (O4).

   Source execution intentionally uses version-only metadata. The build wrapper
   resolves package version plus trusted/local provenance once and tsdown
   replaces private identifiers without changing this tracked module.

   All resolution paths are exercised with injected env/Git commands so tests
   cover trusted input and clean/dirty/non-Git checkouts without mutating the
   real repository.
   ============================================================================= */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_SHA, BUILD_VERSION } from '../src/generated/build-info';
import {
  defaultGitSha,
  resolveBuildInfo,
  resolveBuildSha,
} from '../scripts/write-build-info.mjs';

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

  it('keeps the tracked source fallback version-only', () => {
    expect(BUILD_SHA).toBeUndefined();
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

  it('ignores a blank BT_GIT_SHA before trying GIT_SHA', () => {
    expect(
      resolveBuildSha({ env: { BT_GIT_SHA: ' ', GIT_SHA: 'feedface' }, git: () => 'wrong' }),
    ).toBe('feedface');
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

  it('resolves package version and sha as one build input', () => {
    expect(resolveBuildInfo({ env: { BT_GIT_SHA: 'abc1234' }, root: join(dirname(fileURLToPath(import.meta.url)), '..') }))
      .toEqual({ version: pkg.version, sha: 'abc1234' });
  });
});

describe('defaultGitSha local checkout paths', () => {
  it('returns short HEAD for a clean checkout', () => {
    expect(
      defaultGitSha({
        git: (args) => (args[0] === 'rev-parse' ? '1234abc\n' : ''),
      }),
    ).toBe('1234abc');
  });

  it('marks tracked or untracked changes dirty', () => {
    expect(
      defaultGitSha({
        git: (args) => (args[0] === 'rev-parse' ? '1234abc\n' : '?? local-file\n'),
      }),
    ).toBe('1234abc-dirty');
  });

  it('degrades to version-only outside a Git checkout', () => {
    expect(
      defaultGitSha({
        git: () => {
          throw new Error('not a git repository');
        },
      }),
    ).toBeUndefined();
  });
});
