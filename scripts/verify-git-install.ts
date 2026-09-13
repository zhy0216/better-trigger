#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const entries = {
  './sdk': './packages/sdk/src/index.ts',
  './worker/embedded': './apps/worker/src/embedded.ts',
};

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`);
  }
  return result.stdout;
}

const sha = run('git', ['rev-parse', 'HEAD'], root).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('HEAD must be a full commit SHA');
if (run('git', ['status', '--porcelain'], root).trim()) {
  console.warn('Working tree is dirty; this check installs committed HEAD only.');
}
const temporary = mkdtempSync(join(tmpdir(), 'better-trigger-git-'));
try {
  const remote = join(temporary, 'remote');
  run('git', ['clone', '--no-local', '--quiet', root, remote], temporary);
  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  // Unique synthetic URL avoids Bun's Git cache reusing another local check.
  // --github exercises GitHub's actual pinned-SHA path after pushing.
  const gitUrl = `https://localhost/git/${temporary.split('/').pop()}`;
  const source = process.argv.includes('--github')
    ? `github:zhy0216/better-trigger#${sha}`
    : `git+${gitUrl}#${sha}`;
  const config = join(temporary, 'gitconfig');
  writeFileSync(config, `[url "file://${remote}"]\n\tinsteadOf = ${gitUrl}\n`);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'better-trigger-git-smoke',
    private: true,
    type: 'module',
    dependencies: { '@better-trigger/source': source },
    devDependencies: { '@types/bun': '1.4.0', typescript: '^7.0.2' },
  }, null, 2));
  run('bun', ['install', '--ignore-scripts'], consumer, { ...process.env, GIT_CONFIG_GLOBAL: config });

  const installed = join(consumer, 'node_modules/@better-trigger/source');
  if (lstatSync(installed).isSymbolicLink()) throw new Error('source must be a Git install, not a local link');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  for (const [entry, target] of Object.entries(entries)) {
    if (manifest.exports?.[entry] !== target || !existsSync(join(installed, target))) {
      throw new Error(`missing source export ${entry}`);
    }
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[lifecycle]) throw new Error(`Git source entry must not need ${lifecycle}`);
  }
  for (const dependency of ['pg', 'drizzle-orm', 'croner', 'hono', '@types/pg']) {
    if (!manifest.dependencies?.[dependency]) throw new Error(`missing root dependency ${dependency}`);
  }
  if (existsSync(join(installed, 'apps/worker/dist'))) throw new Error('Git install unexpectedly contains build output');
  writeFileSync(join(consumer, 'verify.ts'), readFileSync(join(installed, 'scripts/fixtures/git-consumer.ts')));
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023', lib: ['ES2023'], module: 'ESNext', moduleResolution: 'bundler',
      strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
      noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true,
      isolatedModules: true, allowImportingTsExtensions: true, resolveJsonModule: true,
      skipLibCheck: true, noEmit: true, types: ['node', 'bun'],
    },
    include: ['verify.ts'],
  }, null, 2));
  run('bun', ['node_modules/typescript/bin/tsc', '--noEmit'], consumer);
  process.stdout.write(run('bun', ['verify.ts'], consumer));
  console.log(`Git source install with lifecycle scripts disabled + strict consumer typecheck: OK (${sha})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
