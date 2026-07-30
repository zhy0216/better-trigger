/* =============================================================================
   check-deps — guards the dependency shape of the two published packages.

   `docs/architecture.md` states that @better-trigger/core "must stay at zero
   runtime dependencies". That is the foundation of the client/daemon split:
   core sits on the SDK's dependency path, so the day core pulls in `pg`,
   `npm i better-trigger` starts installing a database driver again. The same
   goes for the SDK itself — it may depend on core and on nothing else.

   Until now that was an invariant kept in someone's head. This script turns it
   into an assertion: it exits non-zero with the offending names, so CI (and
   `bun run check:deps`) fails on the PR that introduces the dependency rather
   than on the release that ships it.

   Deliberately hard-coded to core + sdk instead of globbing packages/*: the
   other workspace packages (db, kernel, and anything test-only) legitimately
   depend on `pg` and friends. This is a rule about the *published client*
   surface, not a repo-wide ban.

   Usage: node scripts/check-deps.mjs   (or `bun run check:deps` from the root)
   ============================================================================= */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Dependency fields that end up installed in a consumer's node_modules. */
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** One rule per published package. `allowed` is the complete allow-list. */
const RULES = [
  {
    dir: 'packages/core',
    why: 'core is on the SDK dependency path and must install nothing',
    allowed: [],
  },
  {
    dir: 'packages/sdk',
    why: 'the SDK speaks HTTP; core is the only thing it may drag along',
    allowed: ['@better-trigger/core'],
  },
];

const root = fileURLToPath(new URL('..', import.meta.url));
const violations = [];

for (const rule of RULES) {
  const manifestPath = `${root}${rule.dir}/package.json`;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const field of RUNTIME_FIELDS) {
    const names = Object.keys(pkg[field] ?? {});
    const offenders = names.filter((name) => !rule.allowed.includes(name));
    if (offenders.length > 0) {
      violations.push({ rule, field, offenders });
    }
  }

  const expectation =
    rule.allowed.length === 0
      ? 'no runtime dependencies'
      : `runtime dependencies limited to ${rule.allowed.join(', ')}`;
  console.log(`  ${rule.dir}: ${expectation} — ${rule.why}`);
}

if (violations.length > 0) {
  console.error('\n✗ forbidden runtime dependencies:\n');
  for (const { rule, field, offenders } of violations) {
    for (const name of offenders) {
      console.error(`  ${rule.dir}/package.json  ${field}.${name}`);
    }
  }
  console.error(
    '\n  These packages are what `npm i better-trigger` installs. If the code' +
      '\n  genuinely needs this dependency, it belongs in the worker daemon' +
      '\n  (apps/worker) or in @better-trigger/kernel — not here. See' +
      '\n  docs/architecture.md on the client/daemon split.\n'
  );
  process.exit(1);
}

console.log('\n✓ published packages carry no unexpected runtime dependencies');
