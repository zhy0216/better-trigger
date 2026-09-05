import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkArtifacts } from '../scripts/check-artifacts.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, contents: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

// Run the real Turbo/Bun entrypoints and artifact guard in a disposable
// workspace. Only compilers are replaced: their append-only counters prove
// execution counts independently of Turbo's replayed cache logs.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'better-trigger-build-'));
  fixtures.push(root);
  for (const path of ['package.json', 'bun.lock', 'turbo.json', '.gitignore']) {
    cpSync(join(repo, path), join(root, path));
  }
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const path of [
    'apps/web', 'apps/worker', 'apps/docs', 'packages/core', 'packages/db',
    'packages/kernel', 'packages/sdk', 'packages/testing', 'examples/basic',
  ]) {
    const manifest = JSON.parse(readFileSync(join(repo, path, 'package.json'), 'utf8'));
    if (path !== 'apps/worker') {
      manifest.scripts = { build: 'bun fixture-build.mjs' };
      put(root, `${path}/fixture-build.mjs`, "import { mkdirSync } from 'node:fs'; mkdirSync('dist', { recursive: true });");
    }
    put(root, `${path}/package.json`, JSON.stringify(manifest));
  }
  cpSync(join(repo, 'apps/worker/scripts'), join(root, 'apps/worker/scripts'), { recursive: true });
  put(root, 'apps/worker/src/generated/build-info.ts', 'export const BUILD_SHA = undefined;\n');
  put(root, 'apps/web/source.txt', 'dashboard-v1');
  put(root, 'apps/web/fixture-build.mjs', `
    import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
    appendFileSync('../../web-builds.log', 'compile\\n');
    const source = readFileSync('source.txt', 'utf8');
    if (source === 'FAIL') process.exit(1);
    rmSync('dist', { recursive: true, force: true });
    mkdirSync('dist', { recursive: true });
    writeFileSync('dist/index.html', source);
  `);
  put(root, 'apps/worker/node_modules/.bin/tsdown', `#!/usr/bin/env bun
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    appendFileSync('../../worker-builds.log', 'compile\\n');
    mkdirSync('dist', { recursive: true });
    writeFileSync('dist/runtime-fixture.js', 'export const sha = ' + JSON.stringify(process.env.BT_WORKER_BUILD_SHA) + ';');
    for (const name of ['index', 'embedded', 'main']) {
      for (const ext of ['js', 'cjs']) writeFileSync('dist/' + name + '.' + ext, "export { sha } from './runtime-fixture.js';");
      for (const ext of ['d.ts', 'd.cts']) writeFileSync('dist/' + name + '.' + ext, 'export declare const sha: string;');
    }
  `);
  chmodSync(join(root, 'apps/worker/node_modules/.bin/tsdown'), 0o755);
  return root;
}

function build(root: string, direct: boolean, sha: string) {
  const env = { ...process.env, BT_GIT_SHA: sha, TURBO_TELEMETRY_DISABLED: '1' };
  // Tests themselves can run under Turbo. Do not leak the enclosing test
  // task's marker, force/cache settings, or database URL into the fixture.
  for (const name of Object.keys(env)) {
    if (name.startsWith('TURBO_') || name === 'DATABASE_URL' || name === 'GIT_SHA') delete env[name as keyof typeof env];
  }
  env.TURBO_TELEMETRY_DISABLED = '1';
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: direct ? join(root, 'apps/worker') : root,
    env: { ...env, TURBO_CACHE: 'local:rw', TURBO_UI: 'stream' },
    encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

function count(root: string, name: string) {
  const path = join(root, `${name}-builds.log`);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
}

describe('dashboard build orchestration', () => {
  it.each([false, true])('builds fresh assets once, restores cache, and rolls SHA (direct=%s)', (direct) => {
    const root = fixture();
    const worker = join(root, 'apps/worker');
    const sourcePath = join(worker, 'src/generated/build-info.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const first = build(root, direct, 'fixture-sha-first');
    expect(first.status, first.output).toBe(0);
    expect(count(root, 'web')).toBe(1);
    expect(count(root, 'worker')).toBe(1);
    expect(readFileSync(join(worker, 'dist/public/index.html'), 'utf8')).toBe('dashboard-v1');
    checkArtifacts({ root: worker, expectedSha: 'fixture-sha-first' });

    put(root, 'apps/worker/dist/runtime-orphan.js', 'export {};');
    expect(() => checkArtifacts({ root: worker })).toThrow(/orphan artifact/);
    // Cache restoration must work even when all dashboard outputs are absent.
    rmSync(join(root, 'apps/web/dist'), { recursive: true });
    const second = build(root, direct, 'fixture-sha-second');
    expect(second.status, second.output).toBe(0);
    expect(count(root, 'web')).toBe(1);
    expect(count(root, 'worker')).toBe(2);
    expect(readFileSync(join(worker, 'dist/public/index.html'), 'utf8')).toBe('dashboard-v1');
    checkArtifacts({ root: worker, expectedSha: 'fixture-sha-second', rejectShas: ['fixture-sha-first'] });

    put(root, 'apps/web/source.txt', 'dashboard-v2');
    put(root, 'apps/worker/dist/public/obsolete.js', 'old dashboard asset');
    const changed = build(root, direct, 'fixture-sha-third');
    expect(changed.status, changed.output).toBe(0);
    expect(count(root, 'web')).toBe(2);
    expect(count(root, 'worker')).toBe(3);
    expect(readFileSync(join(worker, 'dist/public/index.html'), 'utf8')).toBe('dashboard-v2');
    expect(existsSync(join(worker, 'dist/public/obsolete.js'))).toBe(false);
    checkArtifacts({ root: worker, expectedSha: 'fixture-sha-third', rejectShas: ['fixture-sha-second'] });
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);

    // Existing index.html must not hide a failed rebuild after an input edit.
    put(root, 'apps/web/source.txt', 'FAIL');
    const failed = build(root, direct, 'fixture-sha-failed');
    expect(failed.status, failed.output).not.toBe(0);
    expect(count(root, 'web')).toBe(3);
    expect(count(root, 'worker')).toBe(3);
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
  }, 60_000);

  it('refuses to copy a dashboard with no entry', () => {
    const root = fixture();
    expect(() => execFileSync('bun', ['scripts/copy-public.mjs'], {
      cwd: join(root, 'apps/worker'), stdio: 'pipe',
    })).toThrow();
    expect(count(root, 'web')).toBe(0);
    expect(existsSync(join(root, 'apps/worker/dist/public'))).toBe(false);
  });
});
