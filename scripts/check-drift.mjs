/* =============================================================================
   check-drift — guards that packages/db/src/schema.ts and the generated
   migrations still say the same thing.

   schema.ts is the source of truth, but nothing ever *runs* it: daemons apply
   the .sql files in packages/db/migrations at boot. So an edit to schema.ts
   without a `db:generate` changes nothing in any database — and worse, it sits
   there until some unrelated `db:generate` months later silently folds it into
   that migration. The index shapes the claim/reaper hot loops depend on
   (todos/02-performance.md PF1/PF2) are exactly the kind of thing that goes
   missing this way: dropping `.nullsFirst()` from schema.ts is invisible to
   `packages/db/test/schema-indexes.test.ts` (it reads the committed .sql), and
   the next generate would quietly emit a DESC NULLS LAST rebuild that measures
   as no index at all.

   How it works: copy the committed migrations folder to a scratch directory and
   run `drizzle-kit generate` against *that* copy. drizzle-kit diffs schema.ts
   against the latest snapshot in migrations/meta and writes a file only when
   they differ, so "a new .sql appeared" IS the drift, and its contents are the
   exact SQL that is missing from the repo. The real migrations folder is never
   touched.

   No Postgres needed — `generate` is a pure offline diff (it is `migrate` /
   `push` / `studio` that connect). That is why CI can run this in the same
   place as the other packaging guards instead of behind the database service.

   Scope: this compares schema.ts against migrations/meta, i.e. it catches the
   common failure (schema edited, generate not run). A hand-edited .sql whose
   snapshot was left intact is a different animal; the assertions in
   packages/db/test/schema-indexes.test.ts pin the shipped SQL for the indexes
   that matter.

   Usage: node scripts/check-drift.mjs   (or `bun run check:drift` from the root)
   ============================================================================= */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dbDir = `${root}packages/db`;

/* What we hand drizzle-kit. It refuses `--config` together with any other flag,
   so these are spelled out here — and checked against drizzle.config.ts below,
   because a guard pointed at the wrong schema file would pass forever. */
const DIALECT = 'postgresql';
const SCHEMA = './src/schema.ts';
const MIGRATIONS = 'migrations';

/* Scratch copy lives under node_modules (git-ignored, and outside the `files`
   this package publishes). Relative on purpose: drizzle-kit 0.31 prefixes
   `--out` with './', which mangles absolute paths. */
const OUT_REL = 'node_modules/.cache/drizzle-drift';
const outAbs = `${dbDir}/${OUT_REL}`;

const bin = [`${dbDir}/node_modules/.bin/drizzle-kit`, `${root}node_modules/.bin/drizzle-kit`].find(
  (p) => existsSync(p),
);
if (!bin) {
  console.error('✗ drizzle-kit not found — run `bun install` first');
  process.exit(1);
}

/* The config is what humans run (`bun run db:generate`); if it has moved on,
   this script is diffing something else and its green means nothing. */
const config = readFileSync(`${dbDir}/drizzle.config.ts`, 'utf8');
for (const [what, value] of [
  ['schema', SCHEMA],
  ['out', `./${MIGRATIONS}`],
  ['dialect', DIALECT],
]) {
  if (!config.includes(`'${value}'`)) {
    console.error(
      `✗ packages/db/drizzle.config.ts no longer declares ${what}: '${value}'.` +
        '\n  Update scripts/check-drift.mjs to match, otherwise this guard is' +
        '\n  checking a schema nobody generates from.',
    );
    process.exit(1);
  }
}

const sqlFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];

let generated;
try {
  rmSync(outAbs, { recursive: true, force: true });
  mkdirSync(outAbs, { recursive: true });
  cpSync(`${dbDir}/${MIGRATIONS}`, `${outAbs}/${MIGRATIONS}`, { recursive: true });

  const before = new Set(sqlFiles(`${outAbs}/${MIGRATIONS}`));

  // stdin is closed: `generate` prompts when it cannot tell a rename from a
  // drop/create, and a prompt in CI has to die rather than hang for 20 minutes.
  const run = spawnSync(
    bin,
    [
      'generate',
      '--dialect',
      DIALECT,
      '--schema',
      SCHEMA,
      '--out',
      `${OUT_REL}/${MIGRATIONS}`,
      '--name',
      'drift_probe',
    ],
    { cwd: dbDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (run.error || run.status !== 0) {
    console.error(`✗ drizzle-kit generate failed\n${run.stdout ?? ''}${run.stderr ?? ''}`);
    process.exit(1);
  }

  const added = sqlFiles(`${outAbs}/${MIGRATIONS}`).filter((f) => !before.has(f));

  if (added.length === 0) {
    // drizzle-kit 0.31 exits 0 even when it bailed out early (a bad --out, for
    // instance, only prints an ENOENT), so "no new file" alone is not proof.
    // Its no-op line is.
    if (!`${run.stdout}`.includes('No schema changes')) {
      console.error(
        `✗ inconclusive — drizzle-kit produced neither a migration nor its` +
          `\n  "no schema changes" line:\n${run.stdout}${run.stderr ?? ''}`,
      );
      process.exit(1);
    }
    console.log('✓ packages/db/src/schema.ts matches migrations/ — no ungenerated changes');
  } else {
    generated = added.map((f) => ({
      name: f,
      sql: readFileSync(`${outAbs}/${MIGRATIONS}/${f}`, 'utf8').trim(),
    }));
  }
} finally {
  rmSync(outAbs, { recursive: true, force: true });
}

if (generated) {
  console.error('\n✗ schema.ts has changes that no migration carries:\n');
  for (const { sql } of generated) {
    for (const line of sql.split('\n')) console.error(`  ${line}`);
  }
  console.error(
    '\n  This SQL exists only in schema.ts, so no database has it. Run' +
      '\n  `bun run --filter @better-trigger/db db:generate` and commit the' +
      '\n  migration (plus migrations/meta) alongside the schema edit.\n',
  );
  process.exit(1);
}
