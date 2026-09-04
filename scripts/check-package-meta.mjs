/* =============================================================================
   check-package-meta — published runtime + sideEffects metadata contract
   (plans/repo-improvements-2026-09-04 F7, todos/06).

   Two things a consumer's toolchain reads off the tarball and this repo cannot
   otherwise see:

   1. `engines.node`. The root package declares `>=18`, but a root field is not
      published metadata — a subpackage tarball without its own `engines` tells
      an installing Node nothing about the floor the bundles were compiled to
      (every tsdown config targets node18). Each of the five published packages
      must carry `">=18"` itself.

   2. `sideEffects`. Bundlers use it to decide whether an unused import of a
      package may be dropped. `false` is only correct for code that runs nothing
      on import, and the five entries are NOT uniform — the audit below is what
      each declaration rests on, done over the static import chain of every
      published entry (src/index.ts, src/internal.ts, src/embedded.ts, main.ts):

        core    pure. types, error classes, duration/backoff math, TextEncoder.
        db      pure. drizzle schema builders + pool factory functions; the
                migrations folder is data, read only inside migrate().
        kernel  pure. queue/runs/orchestrator classes and functions, plus a few
                module-level string/Set constants.
        sdk     effectful. registry.ts runs `adopt()` at import, which WRITES
                globalThis[Symbol.for('better-trigger.registry.v1')] so two
                copies of the SDK (app + worker) share one registry. The write
                lands in a build-hashed shared chunk, so entry-name-only
                patterns cannot pin it — the package declares its whole shipped
                bundle graph effectful.
        worker  mixed. embedded.ts writes globalThis[Symbol.for(
                'better-trigger.worker.embedded.v1')] and main.ts registers
                SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers.
                The library entry (dist/index.*) is pure, so only main.* and
                embedded.* are listed.

   A blanket `false` across the five would let a bundler delete two globalThis
   installs and the daemon's signal handling; a blanket `true` would throw away
   the tree-shaking core/db/kernel and unused SDK/worker imports genuinely
   earn. Both directions are asserted against the PACKED tarballs, not the
   workspace, so a manifest that drifts from the audit fails.

   Usage: node scripts/check-package-meta.mjs             (or `bun run check:pkg-meta`)
          node scripts/check-package-meta.mjs --no-shake   bundler fixtures need Bun
          node scripts/check-package-meta.mjs --no-smoke   skip the entry imports
   The entry smoke runs under `process.execPath`, so a CI leg on Node 18/20/22
   gets the consumer-side check without needing Bun's runtime semantics.
   ============================================================================= */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** `false` = provably pure; array = shipped files that must never be dropped.
 *  Both are audit conclusions, not preferences. */
const PACKAGES = [
  { dir: 'packages/core', name: '@better-trigger/core', sideEffects: false },
  { dir: 'packages/db', name: '@better-trigger/db', sideEffects: false },
  { dir: 'packages/kernel', name: '@better-trigger/kernel', sideEffects: false },
  { dir: 'packages/sdk', name: 'better-trigger', sideEffects: ['./dist/*.js', './dist/*.cjs'] },
  {
    dir: 'apps/worker',
    name: '@better-trigger/worker',
    sideEffects: ['./dist/main.js', './dist/main.cjs', './dist/embedded.js', './dist/embedded.cjs'],
  },
];

/** Every published entry ('' = package root), required AND imported so both
 *  exports-map conditions resolve from a clean install. */
const ENTRIES = [
  ['@better-trigger/core', ''],
  ['@better-trigger/db', ''],
  ['@better-trigger/kernel', ''],
  ['better-trigger', ''],
  ['better-trigger', '/internal'],
  ['@better-trigger/worker', ''],
  ['@better-trigger/worker', '/embedded'],
];

/** Effect markers that prove the declaration is being honored by a bundler. */
const SHAKE_FIXTURES = [
  {
    label: 'unused pure entry is eliminated (core)',
    from: '@better-trigger/core',
    keep: [],
    drop: ['serializeError'],
  },
  {
    label: 'unused pure library entry is eliminated (worker index)',
    from: '@better-trigger/worker',
    keep: [],
    drop: ['hono/cors'],
  },
  {
    label: 'effectful entry keeps its global registry install (sdk)',
    from: 'better-trigger',
    keep: ['better-trigger.registry.v1'],
    drop: [],
  },
  {
    label: 'effectful entry keeps its global slot install (worker embedded)',
    from: '@better-trigger/worker/embedded',
    keep: ['better-trigger.worker.embedded.v1'],
    drop: [],
  },
];

const passed = [];
const failed = [];
function assert(condition, what) {
  (condition ? passed : failed).push(what);
}

function sh(file, args, options = {}) {
  const res = spawnSync(file, args, { encoding: 'utf8', ...options });
  if (res.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed (${res.status})\n${res.stdout ?? ''}${res.stderr ?? ''}`);
  }
  return res.stdout ?? '';
}

/** bun pm pack names the tarball after the package, so pack each package into
 *  its own directory and take the single .tgz inside it. */
function packAll(packs) {
  const tarballs = {};
  for (const pkg of PACKAGES) {
    const dir = join(packs, pkg.dir.replace('/', '-'));
    mkdirSync(dir, { recursive: true });
    sh('bun', ['pm', 'pack', '--destination', dir, '--quiet'], { cwd: join(root, pkg.dir) });
    const file = readdirSync(dir).find((name) => name.endsWith('.tgz'));
    if (!file) throw new Error(`${pkg.name} produced no tarball`);
    tarballs[pkg.name] = join(dir, file);
  }
  return tarballs;
}

function readTgz(tarball, member) {
  return sh('tar', ['-xzOf', tarball, member]);
}

function listTgz(tarball) {
  return sh('tar', ['-tzf', tarball])
    .split('\n')
    .map((line) => line.replace(/^package\//, '').replace(/\/$/, ''))
    .filter(Boolean);
}

/** Webpack/bun style sideEffects matcher: `*` matches inside one path segment,
 *  everything else is literal. No shipped pattern needs `**`. */
function patternToRegExp(pattern) {
  let source = '';
  for (const char of pattern.replace(/^\.\/+/, '')) {
    if (char === '*') source += '[^/]*';
    else if ('.+?^${}()|[]\\'.includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

function checkManifests(tarballs) {
  for (const pkg of PACKAGES) {
    const tarball = tarballs[pkg.name];
    const manifest = JSON.parse(readTgz(tarball, 'package/package.json'));
    assert(
      manifest.engines?.node === '>=18',
      `${pkg.name}: packed engines.node is ">=18" (got ${JSON.stringify(manifest.engines?.node)})`,
    );
    const declared = JSON.stringify(manifest.sideEffects ?? null);
    assert(
      declared === JSON.stringify(pkg.sideEffects),
      `${pkg.name}: packed sideEffects is ${JSON.stringify(pkg.sideEffects)} (got ${declared})`,
    );
    if (Array.isArray(manifest.sideEffects)) {
      const files = listTgz(tarball);
      for (const pattern of manifest.sideEffects) {
        const re = patternToRegExp(pattern);
        const hits = files.filter((file) => re.test(file));
        assert(hits.length > 0, `${pkg.name}: sideEffects pattern ${pattern} matches packed files`);
      }
    }
    assert(
      /target:\s*'node18'/.test(readFileSync(join(root, pkg.dir, 'tsdown.config.ts'), 'utf8')),
      `${pkg.dir}: tsdown target stays aligned with the declared node18 floor`,
    );
  }
}

function installConsumer(tarballs, dir) {
  const deps = Object.fromEntries(Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]));
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'pkg-meta-consumer', private: true, dependencies: deps, overrides: deps }, null, 2)}\n`,
  );
  // bun resolves a dependency of a file: tarball against the registry unless it
  // is overridden to the same local tarball; every @better-trigger/* dep lives
  // in this pack set, so the whole graph installs without a published version.
  sh('bun', ['install', '--silent'], { cwd: dir });
}

function entryResolves(dir, specifier, mode) {
  const source =
    mode === 'cjs'
      ? `const m = require(${specifier}); if (!m || typeof m !== 'object' || Object.keys(m).length === 0) process.exit(1)`
      : `const m = await import(${specifier}); if (!m || Object.keys(m).length === 0) process.exit(1)`;
  const args = mode === 'cjs' ? ['-e', source] : ['--input-type=module', '-e', source];
  return spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' }).status === 0;
}

function checkEntries(dir) {
  for (const [name, subpath] of ENTRIES) {
    const specifier = JSON.stringify(name + subpath);
    assert(entryResolves(dir, specifier, 'cjs'), `require() ${name}${subpath || '.'} resolves with exports`);
    assert(entryResolves(dir, specifier, 'esm'), `import() ${name}${subpath || '.'} resolves with exports`);
  }
  const help = spawnSync(
    process.execPath,
    [join(dir, 'node_modules/@better-trigger/worker/dist/main.js'), '--help'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert(help.status === 0 && /better-trigger/i.test(`${help.stdout}${help.stderr}`), 'packed worker CLI answers --help');
}

function checkTreeShaking(dir) {
  let index = 0;
  for (const fixture of SHAKE_FIXTURES) {
    index += 1;
    const entry = join(dir, `shake-${index}.mjs`);
    const out = join(dir, `shake-${index}.js`);
    writeFileSync(entry, `import ${JSON.stringify(fixture.from)};\nconsole.log('consumer');\n`);
    sh('bun', ['build', '--target=node', `--outfile=${out}`, entry], { cwd: dir });
    const bundle = readFileSync(out, 'utf8');
    rmSync(entry, { force: true });
    rmSync(out, { force: true });
    for (const marker of fixture.keep) {
      assert(bundle.includes(marker), `${fixture.label}: bundle keeps ${marker}`);
    }
    for (const marker of fixture.drop) {
      assert(!bundle.includes(marker), `${fixture.label}: bundle drops ${marker}`);
    }
  }
}

const packs = mkdtempSync(join(tmpdir(), 'bt-packs-'));
const consumer = mkdtempSync(join(tmpdir(), 'bt-consumer-'));
try {
  const tarballs = packAll(packs);
  checkManifests(tarballs);
  installConsumer(tarballs, consumer);
  if (!process.argv.includes('--no-smoke')) checkEntries(consumer);
  if (!process.argv.includes('--no-shake')) checkTreeShaking(consumer);
} catch (error) {
  failed.push(String(error instanceof Error ? error.message : error));
} finally {
  rmSync(packs, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
}

for (const line of passed) console.log(`  ✓ ${line}`);
for (const line of failed) console.error(`  ✗ ${line}`);
console.log(
  `${failed.length === 0 ? '✓' : '✗'} package metadata contract: ${passed.length} passed, ${failed.length} failed (node ${process.versions.node})`,
);
process.exit(failed.length === 0 ? 0 : 1);
