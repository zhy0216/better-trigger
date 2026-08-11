/* =============================================================================
   @better-trigger/db — the C5 referential-integrity and state constraints
   (todos/01-correctness.md) reach a database.

   schema.ts declares the five relations (queue/waits → runs CASCADE,
   runs.parent_run_id → runs SET NULL, schedules → tasks CASCADE) and the
   CHECK-constrained enums, but nothing runs schema.ts: only the generated SQL
   in ../migrations is applied, so a schema edit without a `bun run db:generate`
   would leave the database with no constraints at all while the code believes
   they exist. These read the shipped .sql files (no Postgres, no drizzle-kit)
   and pin that pairing — the same guarantee schema-retention.test.ts gives the
   0007 cascades.

   The second half is the one that matters operationally: `ADD CONSTRAINT ...
   FOREIGN KEY` validates existing rows, daemons auto-migrate at boot
   (apps/worker/src/main.ts), and a database carrying orphans would therefore
   fail the migration and stop every daemon on it from starting. The 0011
   migration deletes/sets-null orphans first; that ordering is pinned here.

   The live half (the constraints actually firing — a manual DELETE leaving no
   orphan, an illegal status refused) is examples/basic/scripts/constraints.ts.
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

/** The last statement adding a named constraint (a later drop would fail the
 *  test via the regex not matching, so no tombstone handling is needed). */
const constraint = (name: string): string =>
  migrationSql.match(new RegExp(`ALTER TABLE "[^"]+" ADD CONSTRAINT "${name}"[^;]*`))?.[0] ?? '';

/* ---------------------------------------------------------------------------
 * Foreign keys
 * ------------------------------------------------------------------------- */

describe.each([
  ['queue', 'queue_run_id_runs_id_fk', 'run_id', 'runs', 'id', 'cascade'],
  ['waits', 'waits_run_id_runs_id_fk', 'run_id', 'runs', 'id', 'cascade'],
  // SET NULL, NOT cascade: deleting a child run must never strand its
  // 'waiting' parent — the orchestrator recovers the NULLed wait instead
  // (ChildLostError), see orchestrator.ts scanWaits.
  ['waits', 'waits_child_run_id_runs_id_fk', 'child_run_id', 'runs', 'id', 'set null'],
  ['runs', 'runs_parent_run_id_runs_id_fk', 'parent_run_id', 'runs', 'id', 'set null'],
  [
    'schedules',
    'schedules_project_id_env_task_id_tasks_project_id_env_id_fk',
    'project_id","env","task_id',
    'tasks',
    'project_id","env","id',
    'cascade',
  ],
] as const)('%s %s', (table, name, column, refTable, refColumn, onDelete) => {
  const add = constraint(name);

  it('is added by a migration, referencing the right table and column(s)', () => {
    expect(add).toMatch(new RegExp(`FOREIGN KEY \\("${column}"\\) REFERENCES "public"\\."${refTable}"\\("${refColumn}"\\)`));
  });

  it(`has ON DELETE ${onDelete}`, () => {
    expect(add).toMatch(new RegExp(`ON DELETE ${onDelete}`));
  });

  it('is preceded by the orphan cleanup for its referencing column', () => {
    // ADD CONSTRAINT validates every existing row, and the daemon migrates on
    // boot: an orphan left behind by an older database would fail the
    // migration and stop everyone's daemon from starting.
    const addIdx = migrationSql.indexOf(`ADD CONSTRAINT "${name}"`);
    expect(addIdx).toBeGreaterThan(-1);
    const prefix = migrationSql.slice(0, addIdx);
    if (onDelete === 'set null') {
      // The orphan is SET NULL, matching the FK's own ON DELETE action: the
      // referencing row survives (for runs.parent_run_id the child run, for
      // waits.child_run_id the parent wait — which the orchestrator then
      // fails instead of stranding).
      expect(prefix).toMatch(
        new RegExp(`UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" IS NOT NULL AND NOT EXISTS \\(SELECT 1 FROM "runs"`),
      );
    } else {
      // The others are dangling derived rows (queue / waits / schedules): the
      // cleanup deletes them.
      expect(prefix).toMatch(new RegExp(`DELETE FROM "${table}"`));
      expect(prefix).toMatch(/NOT EXISTS \(SELECT 1 FROM "runs"|NOT EXISTS \(SELECT 1 FROM "tasks"/);
    }
  });
});

/* ---------------------------------------------------------------------------
 * CHECK constraints — the closed enums
 * ------------------------------------------------------------------------- */

describe.each([
  ['runs', 'runs_status_check', "IN ('queued','running','waiting','completed','failed','canceled')"],
  ['run_steps', 'run_steps_status_check', "IN ('completed','failed')"],
  [
    'run_steps',
    'run_steps_kind_check',
    "IN ('step','wait','trigger-and-wait','batch-trigger','now','random','uuid')",
  ],
  ['waits', 'waits_status_check', "IN ('pending','completed','canceled')"],
  ['waits', 'waits_kind_check', "IN ('duration','until','run')"],
  ['workers', 'workers_status_check', "IN ('online','offline')"],
  ['logs', 'logs_level_check', "IN ('debug','info','warn','error')"],
] as const)('%s %s', (table, name, values) => {
  const add = constraint(name);

  it('is added by a migration on the table it constrains', () => {
    expect(add).toMatch(new RegExp(`CHECK \\("${table}"\\.`));
  });

  it('lists exactly the legal values', () => {
    expect(add).toMatch(new RegExp(values.replace(/[()']/g, '\\$&')));
  });
});

describe('attempt / recoveries arithmetic checks', () => {
  it('runs.attempt >= 1 — attempts are 1-based', () => {
    expect(constraint('runs_attempt_check')).toMatch(/CHECK \("runs"\."attempt" >= 1\)/);
  });

  it('run_steps.attempt >= 1', () => {
    expect(constraint('run_steps_attempt_check')).toMatch(/CHECK \("run_steps"\."attempt" >= 1\)/);
  });

  it('runs.recoveries stays within its own ceiling', () => {
    expect(constraint('runs_recoveries_check')).toMatch(
      /CHECK \("runs"\."recoveries" >= 0 AND "runs"\."recoveries" <= "runs"\."max_recoveries"\)/,
    );
  });
});
