/* =============================================================================
   bump-versions.mjs — release-time version bump for the publishable packages.

   Usage: node scripts/bump-versions.mjs <patch|minor|major|semver>

   Bumps the five publishable packages (core, db, kernel, sdk, worker) in
   lockstep and — the part that matters — syncs their versions into bun.lock.
   `bun pm pack` rewrites `workspace:*` dependencies to the versions recorded
   in the lockfile's `workspaces` section, NOT to package.json: bumping only
   package.json would ship tarballs that depend on the previous (unpublished)
   versions, and `bun install` does not refresh those entries on its own.

   - patch|minor|major bump each package from ITS OWN current version.
   - An explicit semver (e.g. 0.2.0, 0.2.0-beta.1) sets every package to
     exactly that version — idempotent, and therefore the form to re-run
     after a partially failed publish (npm refuses to overwrite a published
     version, so always pass a NEW one).

   The root package.json (private) and the private apps stay untouched.
   ============================================================================= */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The five packages that publish to npm, in dependency order. */
const PUBLISHABLE = [
  'packages/core',
  'packages/db',
  'packages/kernel',
  'packages/sdk',
  'apps/worker',
];

const input = process.argv[2];
if (input === undefined) {
  console.error('usage: node scripts/bump-versions.mjs <patch|minor|major|semver>');
  process.exit(2);
}

const EXPLICIT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The next version for `current` under the given input. */
function nextVersion(current, input) {
  if (input === 'patch' || input === 'minor' || input === 'major') {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
    if (match === null) {
      throw new Error(`cannot ${input}-bump non-semver version "${current}"`);
    }
    let [, major, minor, patch] = match.map(Number);
    if (input === 'patch') patch += 1;
    else if (input === 'minor') { minor += 1; patch = 0; }
    else { major += 1; minor = 0; patch = 0; }
    return `${major}.${minor}.${patch}`;
  }
  if (!EXPLICIT.test(input)) {
    throw new Error(`"${input}" is not patch|minor|major or an explicit semver`);
  }
  return input;
}

/** Read a package.json, bump it, write it back. Returns [name, version]. */
function bumpPackage(dir) {
  const path = join(ROOT, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = nextVersion(pkg.version, input);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return [pkg.name, pkg.version];
}

const bumped = PUBLISHABLE.map(bumpPackage);

/* ---- sync bun.lock -------------------------------------------------------- */

const lockPath = join(ROOT, 'bun.lock');
let lock = readFileSync(lockPath, 'utf8');
for (const [dir, [name, version]] of bumped.map((b, i) => [PUBLISHABLE[i], b])) {
  // Each workspace entry reads: "<dir>": { "name": "<name>", "version": "x.y.z",
  // — patch only that entry's own version field (never its dependency lists).
  const pattern = new RegExp(
    `("${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": \\{\\s*"name": "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",\\s*"version": ")[^"]*(")`,
  );
  const next = lock.replace(pattern, `$1${version}$2`);
  if (next === lock) {
    throw new Error(`bun.lock has no workspace entry for ${dir} (${name})`);
  }
  lock = next;
}
writeFileSync(lockPath, lock);

/* ---- self-check: package.json and bun.lock must now agree ---------------- */

const lockJson = JSON.parse(lock.replace(/,\s*([}\]])/g, '$1'));
for (const dir of PUBLISHABLE) {
  const entry = lockJson.workspaces?.[dir];
  if (entry === undefined) throw new Error(`bun.lock lost the ${dir} entry`);
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  if (entry.version !== pkg.version) {
    throw new Error(`${dir}: lock version ${entry.version} != package.json ${pkg.version}`);
  }
}

console.log(`bumped ${PUBLISHABLE.length} packages to their new versions and synced bun.lock`);
for (const [_dir, [name, version]] of bumped.map((b, i) => [PUBLISHABLE[i], b])) {
  console.log(`  ${name}@${version}`);
}
