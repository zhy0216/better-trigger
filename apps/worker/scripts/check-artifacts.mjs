#!/usr/bin/env node
/* =============================================================================
   @better-trigger/worker — final dist/package artifact guard.

   Starting from the configured package/bin/type entries, walk every relative
   JS/CJS/declaration import and sourceMappingURL. Anything outside that graph
   must be an explicitly allowed stable entry or dashboard file. The same
   files are then compared with `bun pm pack --dry-run`, so stale chunks and
   maps cannot silently ride along in the published tarball.
   ============================================================================= */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_FILE = /(?:\.[cm]?js|\.d\.(?:[cm]?ts))$/;
const STABLE_ENTRY = /^(?:index|embedded|main)\.(?:js|cjs|d\.ts|d\.cts)$/;
const ANSI = /\x1b\[[0-9;]*m/g;

function slash(file) {
  return file.split(sep).join('/');
}

function walk(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`artifact must not be a symlink: ${slash(relative(root, absolute))}`);
    }
    if (entry.isDirectory()) files.push(...walk(root, absolute));
    else if (entry.isFile()) files.push(slash(relative(root, absolute)));
    else throw new Error(`unsupported artifact type: ${slash(relative(root, absolute))}`);
  }
  return files.sort();
}

function collectManifestPaths(value, paths = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/')) paths.add(value.slice('./dist/'.length));
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectManifestPaths(item, paths);
    return paths;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectManifestPaths(item, paths);
  }
  return paths;
}

function references(source) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\/\/[#@]\s*sourceMappingURL=([^\s]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

function resolveReference(from, specifier, files) {
  // Bundlers conventionally write `sourceMappingURL=file.js.map` without a
  // leading `./`; imports without `./` remain external package specifiers.
  const local = !specifier.startsWith('.') && specifier.endsWith('.map')
    ? `./${specifier}`
    : specifier;
  if (!local.startsWith('.')) return undefined;
  const candidate = posix.normalize(posix.join(posix.dirname(from), local));
  const attempts = [candidate];
  if (/\.d\.(?:[cm]?ts)$/.test(from)) {
    if (candidate.endsWith('.cjs')) attempts.push(candidate.slice(0, -4) + '.d.cts');
    if (candidate.endsWith('.mjs')) attempts.push(candidate.slice(0, -4) + '.d.mts');
    if (candidate.endsWith('.js')) attempts.push(candidate.slice(0, -3) + '.d.ts');
  }
  if (posix.extname(candidate) === '') {
    attempts.push(`${candidate}.js`, `${candidate}.cjs`, `${candidate}.d.ts`, `${candidate}.d.cts`);
  }
  const target = attempts.find((attempt) => files.has(attempt));
  if (!target) throw new Error(`${from} references missing artifact ${specifier}`);
  if (target === '..' || target.startsWith('../')) {
    throw new Error(`${from} references artifact outside dist: ${specifier}`);
  }
  return target;
}

/** Walk runtime/type chunks and maps from package entries plus the stable
 * tsdown outputs for the three configured source entries. */
export function checkArtifactGraph({ distDir, entries, requirePublic = true }) {
  if (!existsSync(distDir)) throw new Error(`worker dist is missing: ${distDir}`);
  const names = walk(distDir);
  const files = new Set(names);
  const stable = names.filter((name) => STABLE_ENTRY.test(name));
  const roots = [...new Set([...entries, ...stable])].sort();

  for (const entry of entries) {
    if (!files.has(entry)) throw new Error(`package entry is missing: ${entry}`);
  }
  if (requirePublic && !files.has('public/index.html')) {
    throw new Error('dashboard entry is missing: public/index.html');
  }

  const reachable = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    if (!files.has(file)) throw new Error(`artifact graph root is missing: ${file}`);
    reachable.add(file);
    if (!CODE_FILE.test(file)) continue;
    const source = readFileSync(join(distDir, file), 'utf8');
    for (const specifier of references(source)) {
      // tsdown currently leaves declaration-map comments while not emitting
      // declaration maps. They are not published artifacts; should one appear,
      // it remains unreachable and is rejected below.
      if (/\.d\.(?:[cm]?ts)$/.test(file) && specifier.endsWith('.map')) continue;
      const target = resolveReference(file, specifier, files);
      if (target && !reachable.has(target)) queue.push(target);
    }
  }

  for (const file of names) {
    if (file.startsWith('public/')) continue;
    if (file.endsWith('.map')) {
      const owner = file.slice(0, -'.map'.length);
      if (!files.has(owner)) throw new Error(`orphan sourcemap has no generated file: ${file}`);
    }
    if (!reachable.has(file)) throw new Error(`orphan artifact is not reachable from an entry: ${file}`);
  }

  return { files: names, reachable };
}

/** Parse Bun's machine-stable dry-run file lines (`packed <size> <path>`). */
export function parsePackList(output) {
  const files = [];
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const match = /^packed\s+\S+\s+(.+)$/.exec(raw.trim());
    if (match) files.push(slash(match[1]));
  }
  if (files.length === 0) throw new Error('bun pm pack --dry-run returned no file list');
  return files.sort();
}

function dryRunPack(root) {
  return parsePackList(
    execFileSync('bun', ['pm', 'pack', '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

export function checkArtifacts({ root = workerRoot, packFiles, expectedSha, rejectShas = [] } = {}) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entries = collectManifestPaths({
    main: packageJson.main,
    module: packageJson.module,
    types: packageJson.types,
    exports: packageJson.exports,
    typesVersions: packageJson.typesVersions,
    bin: packageJson.bin,
  });
  const distDir = join(root, 'dist');
  const graph = checkArtifactGraph({ distDir, entries: [...entries] });

  const packed = packFiles ? [...packFiles].sort() : dryRunPack(root);
  const packedSet = new Set(packed);
  for (const file of graph.files) {
    const packedName = `dist/${file}`;
    if (!packedSet.has(packedName)) throw new Error(`dist artifact is absent from package: ${packedName}`);
  }
  for (const file of packed) {
    if (file.startsWith('dist/')) {
      if (!graph.files.includes(file.slice('dist/'.length))) {
        throw new Error(`package contains an unknown dist artifact: ${file}`);
      }
      continue;
    }
    if (!/^(?:package\.json|README(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?)$/i.test(file)) {
      throw new Error(`package contains a file outside the publish allowlist: ${file}`);
    }
  }

  const runtimeText = [...graph.reachable]
    .filter((file) => /\.[cm]?js$/.test(file))
    .map((file) => readFileSync(join(distDir, file), 'utf8'))
    .join('\n');
  if (runtimeText.includes('__BETTER_TRIGGER_BUILD_')) {
    throw new Error('bundle still contains unresolved build metadata identifiers');
  }
  if (expectedSha && !runtimeText.includes(expectedSha)) {
    throw new Error(`bundle does not contain expected build SHA: ${expectedSha}`);
  }
  for (const sha of rejectShas) {
    if (sha && runtimeText.includes(sha)) throw new Error(`bundle still contains rejected build SHA: ${sha}`);
  }

  return { files: graph.files, packed };
}

function valuesAfter(flag) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] !== flag) continue;
    const value = process.argv[i + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    values.push(value);
    i += 1;
  }
  return values;
}

function main() {
  const expected = valuesAfter('--expected-sha');
  const rejectShas = valuesAfter('--reject-sha');
  const result = checkArtifacts({ expectedSha: expected[0], rejectShas });
  console.log(
    `[worker] artifacts verified: ${result.files.length} dist files, ${result.packed.length} packed files`,
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
