/* =============================================================================
   @better-trigger/db — the retention cascades reach a database
   (todos/02-performance.md PF6).

   schema.ts declares `logs.run_id` / `run_steps.run_id` as foreign keys ON
   DELETE CASCADE, but nothing runs schema.ts: only the generated SQL in
   ../migrations is applied, and the kernel's prune path deletes *runs* and
   trusts the database to take the rest. A schema edit without a
   `bun run db:generate` would leave every pruned run's logs behind, silently.

   The baseline creates both FKs together with their (empty) tables in the
   fixed "better_trigger" schema, so the old upgrade-path orphan cleanup ("a
   dangling log row would fail ADD CONSTRAINT's validation and brick boot")
   no longer exists and is no longer asserted.

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
    new RegExp(
      `ALTER TABLE "better_trigger"."${table}" ADD CONSTRAINT "${constraint}"[^;]*`,
    ),
  )?.[0];

  it('is added by the baseline, referencing runs(id) in better_trigger', () => {
    expect(add).toBeDefined();
    expect(add).toMatch(
      /FOREIGN KEY \("run_id"\) REFERENCES "better_trigger"\."runs"\("id"\)/,
    );
  });

  it('cascades on delete — pruning a run has to take its rows with it', () => {
    // Without the cascade, `DELETE FROM better_trigger.runs` raises a
    // foreign-key violation instead, which would turn retention from "deletes
    // history" into "cannot delete anything at all".
    expect(add).toMatch(/ON DELETE cascade/);
  });
});
