import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkArtifactGraph,
  checkArtifacts,
  parsePackList,
} from '../scripts/check-artifacts.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'better-trigger-artifacts-'));
  temporaryDirectories.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const output = join(root, file);
    mkdirSync(join(output, '..'), { recursive: true });
    writeFileSync(output, contents);
  }
  return root;
}

const validGraph = {
  'index.js': "export { value } from './runtime-abc12345.js';\n//# sourceMappingURL=index.js.map\n",
  'index.js.map': '{}',
  'runtime-abc12345.js': 'export const value = 1;\n//# sourceMappingURL=runtime-abc12345.js.map\n',
  'runtime-abc12345.js.map': '{}',
};

describe('worker artifact graph guard', () => {
  it('accepts chunks and sourcemaps reachable from an entry', () => {
    const result = checkArtifactGraph({
      distDir: fixture(validGraph),
      entries: ['index.js'],
      requirePublic: false,
    });
    expect([...result.reachable].sort()).toEqual(Object.keys(validGraph).sort());
  });

  it('rejects an orphan hashed JavaScript chunk', () => {
    const distDir = fixture({ ...validGraph, 'runtime-old00000.js': 'export {};' });
    expect(() =>
      checkArtifactGraph({ distDir, entries: ['index.js'], requirePublic: false }),
    ).toThrow(/orphan artifact.*runtime-old00000\.js/);
  });

  it('rejects an orphan sourcemap', () => {
    const distDir = fixture({ ...validGraph, 'runtime-old00000.js.map': '{}' });
    expect(() =>
      checkArtifactGraph({ distDir, entries: ['index.js'], requirePublic: false }),
    ).toThrow(/orphan sourcemap.*runtime-old00000\.js\.map/);
  });

  it('rejects a missing package entry', () => {
    expect(() =>
      checkArtifactGraph({
        distDir: fixture(validGraph),
        entries: ['missing.cjs'],
        requirePublic: false,
      }),
    ).toThrow(/package entry is missing: missing\.cjs/);
  });
});

describe('Bun pack list parser', () => {
  it('extracts the exact tarball file list', () => {
    expect(
      parsePackList('bun pack v1.4.0\n\npacked 10B dist/index.js\npacked 2KB package.json\n'),
    ).toEqual(['dist/index.js', 'package.json']);
  });
});

describe('worker package guard', () => {
  function packageFixture(runtime = 'export const BUILD_SHA = "bbbbbbb";'): {
    root: string;
    packFiles: string[];
  } {
    const files = {
      'package.json': JSON.stringify({
        name: '@better-trigger/worker-fixture',
        version: '0.1.0',
        main: './dist/index.cjs',
        module: './dist/index.js',
        types: './dist/index.d.ts',
        bin: { worker: './dist/main.js' },
      }),
      'dist/index.cjs': runtime,
      'dist/index.js': runtime,
      'dist/index.d.ts': 'export declare const BUILD_SHA: string;',
      'dist/main.js': runtime,
      'dist/public/index.html': '<!doctype html>',
    };
    const root = fixture(files);
    return { root, packFiles: Object.keys(files).sort() };
  }

  it('checks runtime, type, CLI, dashboard, and exact pack files together', () => {
    const input = packageFixture();
    expect(checkArtifacts({ ...input, expectedSha: 'bbbbbbb' }).files).toContain(
      'public/index.html',
    );
  });

  it('rejects a previous build SHA even when it is in a reachable chunk', () => {
    const input = packageFixture('export const ids = ["aaaaaaa", "bbbbbbb"];');
    expect(() =>
      checkArtifacts({ ...input, expectedSha: 'bbbbbbb', rejectShas: ['aaaaaaa'] }),
    ).toThrow(/bundle still contains rejected build SHA: aaaaaaa/);
  });
});
