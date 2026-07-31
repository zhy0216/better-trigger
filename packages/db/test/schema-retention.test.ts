/* =============================================================================
   @better-trigger/db — the retention cascades reach a database
   (todos/02-performance.md PF6), and the migration that adds them cannot brick
   a boot.

   schema.ts declares `logs.run_id` / `run_steps.run_id` as foreign keys ON
   DELETE CASCADE, but nothing runs schema.ts: only the generated SQL in
   ../migrations is applied, and the kernel's prune path deletes *runs* and
   trusts the database to take the rest. A schema edit without a
   `bun run db:generate` would leave every pruned run's logs behind, silently.

   The second half is the one that matters operationally: `ADD CONSTRAINT ...
   FOREIGN KEY` validates existing rows, daemons auto-migrate at boot
   (apps/worker/src/main.ts), and a database carrying one orphaned log row would
   therefore fail the migration and stop every daemon on it from starting. The
   migration deletes orphans first; that ordering is pinned here.

   Reads the shipped .sql files — no Postgres, no drizzle-kit. The live half
   (the cascade actually firing) is examples/basic/scripts/retention.ts.
   ============================================================================= */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Every generated migration, concatenated in application order. */
const migrationSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8'))
  .join('\n');

describe.each([
  ['logs', 'logs_run_id_runs_id_fk'],
  ['run_steps', 'run_steps_run_id_runs_id_fk'],
])('%s.run_id → runs.id', (table, constraint) => {
  const add = migrationSql.match(
    new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}"[^;]*`),
  )?.[0];

  it('is added by a migration, referencing runs(id)', () => {
    expect(add).toBeDefined();
    expect(add).toMatch(/FOREIGN KEY \("run_id"\) REFERENCES "public"\."runs"\("id"\)/);
  });

  it('cascades on delete — pruning a run has to take its rows with it', () => {
    // Without the cascade, `DELETE FROM runs` raises a foreign-key violation
    // instead, which would turn retention from "deletes history" into
    // "cannot delete anything at all".
    expect(add).toMatch(/ON DELETE cascade/);
  });

  it('is preceded by an orphan cleanup in the same migration', () => {
    // ADD CONSTRAINT validates every existing row, and the daemon migrates on
    // boot: an orphan left behind by an older database would fail the
    // migration and stop everyone's daemon from starting.
    const cleanup = migrationSql.indexOf(`DELETE FROM "${table}"`);
    expect(cleanup).toBeGreaterThan(-1);
    expect(migrationSql.slice(cleanup)).toMatch(
      new RegExp(`NOT EXISTS \\(SELECT 1 FROM "runs"`),
    );
    expect(cleanup).toBeLessThan(migrationSql.indexOf(`ADD CONSTRAINT "${constraint}"`));
  });
});
