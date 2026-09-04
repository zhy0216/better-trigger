#!/usr/bin/env node
/* =============================================================================
   @better-trigger/worker — provenance-aware, clean build boundary.

   The historical script name is retained because release/Docker callers use
   it, but it no longer writes src/generated/build-info.ts. It resolves one
   build identity, removes dist explicitly, and passes immutable define values
   to tsdown. Consequently success, failure, and interruption cannot modify a
   tracked source input.

   Provenance order:
     1. non-empty BT_GIT_SHA, then GIT_SHA (trusted CI/Docker input);
     2. local short HEAD, suffixed -dirty when tracked or untracked files differ;
     3. undefined outside a Git checkout (an explicit version-only build).
   ============================================================================= */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function trimmed(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Resolve clean/dirty local Git identity. The command runner is injectable so
 * all three local paths are covered without mutating the real checkout. */
export function defaultGitSha({ git = runGit } = {}) {
  try {
    const sha = trimmed(git(['rev-parse', '--short', 'HEAD']));
    if (!sha) return undefined;
    const status = git(['status', '--porcelain', '--untracked-files=normal']);
    return status.trim() === '' ? sha : `${sha}-dirty`;
  } catch {
    return undefined;
  }
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: workerRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Trusted environment identity first, then the checkout, then version-only. */
export function resolveBuildSha({ env = process.env, git = defaultGitSha } = {}) {
  return trimmed(env.BT_GIT_SHA) ?? trimmed(env.GIT_SHA) ?? git();
}

/** Package version and provenance resolved together for one build invocation. */
export function resolveBuildInfo({ env = process.env, git = defaultGitSha, root = workerRoot } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = trimmed(pkg.version);
  if (!version) throw new Error('[worker] package.json must contain a non-empty version');
  return { version, sha: resolveBuildSha({ env, git }) };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: workerRoot, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`[worker] ${command} ${args.join(' ')} failed (${detail})`);
  }
}

function main() {
  const { version, sha } = resolveBuildInfo();
  const buildEnv = {
    ...process.env,
    BT_WORKER_BUILD_VERSION: version,
    BT_WORKER_BUILD_SHA: sha ?? '',
  };

  // Explicitly clean at the task boundary. This remains correct even if a
  // bundler changes its clean behaviour; Turbo caching is disabled for this
  // task because Git dirty state is not a stable declared hash input.
  rmSync(join(workerRoot, 'dist'), { recursive: true, force: true });
  console.log(
    `[worker] build info: version=${version}${sha ? ` sha=${sha}` : ' (no git checkout — version only)'}`,
  );

  run('bunx', ['--bun', 'tsdown'], buildEnv);
  run('bun', ['scripts/copy-public.mjs'], buildEnv);
  run('bun', ['scripts/check-artifacts.mjs', ...(sha ? ['--expected-sha', sha] : [])], buildEnv);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
