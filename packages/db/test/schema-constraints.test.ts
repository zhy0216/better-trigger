/* =============================================================================
   @better-trigger/db — the C5 referential-integrity and state constraints
   (todos/01-correctness.md) reach a database.

   schema.ts declares the relations (queue/waits/run_steps/logs/
   run_retry_operations → runs, runs.parent_run_id → runs SET NULL,
   waits.child_run_id → runs SET NULL, schedules → tasks CASCADE) and the
   CHECK-constrained enums, but nothing runs schema.ts: only the generated SQL
   in ../migrations is applied, so a schema edit without a `bun run db:generate`
   would leave the database with no constraints at all while the code believes
   they exist. These read the shipped .sql files (no Postgres, no drizzle-kit)
   and pin that pairing — the same guarantee schema-retention.test.ts gives the
   prune cascades.

   The baseline creates every FK and CHECK together with its (empty) table in
   the fixed "better_trigger" schema, so the old upgrade-path orphan cleanups
   ("delete dangling rows before ADD CONSTRAINT validates them") no longer
   exist and are no longer asserted — there are no pre-existing rows to clean.
   Everything is schema-qualified so a host project's same-named tables in
   `public` are never referenced.

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

/** The statement declaring a named constraint — either the baseline's inline
 *  `CONSTRAINT "x" CHECK (...)` inside CREATE TABLE (one per line) or a
 *  separate `ALTER TABLE ... ADD CONSTRAINT` for the FKs. `[^;\n]*` stops at
 *  the end of that one declaration, never swallowing a sibling constraint. */
const constraint = (name: string): string =>
  migrationSql.match(
    new RegExp(`(?:ALTER TABLE "better_trigger"\\."[^"]+" ADD )?CONSTRAINT "${name}"[^;\\n]*`),
  )?.[0] ?? '';

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

  it('is added on the qualified table, referencing the qualified target', () => {
    expect(add).toMatch(
      new RegExp(`^ALTER TABLE "better_trigger"\\."${table}" ADD CONSTRAINT "${name}"`),
    );
    expect(add).toMatch(
      new RegExp(
        `FOREIGN KEY \\("${column}"\\) REFERENCES "better_trigger"\\."${refTable}"\\("${refColumn}"\\)`,
      ),
    );
  });

  it(`has ON DELETE ${onDelete}`, () => {
    expect(add).toMatch(new RegExp(`ON DELETE ${onDelete}`));
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
  ['runs', 'runs_trigger_type_check', "IN ('api','schedule','subtask','retry','dashboard')"],
  ['tasks', 'tasks_trigger_source_check', "IN ('api','schedule')"],
] as const)('%s %s', (table, name, values) => {
  const add = constraint(name);

  it('is declared by the baseline on the table it constrains', () => {
    expect(add).toMatch(new RegExp(`CONSTRAINT "${name}" CHECK \\("better_trigger"\\."${table}"\\.`));
  });

  it('lists exactly the legal values', () => {
    expect(add).toMatch(new RegExp(values.replace(/[()']/g, '\\$&')));
  });
});

describe('attempt / recoveries arithmetic checks', () => {
  it('runs.attempt >= 1 — attempts are 1-based', () => {
    expect(constraint('runs_attempt_check')).toMatch(
      /CHECK \("better_trigger"\."runs"\."attempt" >= 1\)/,
    );
  });

  it('run_steps.attempt >= 1', () => {
    expect(constraint('run_steps_attempt_check')).toMatch(
      /CHECK \("better_trigger"\."run_steps"\."attempt" >= 1\)/,
    );
  });

  it('runs.recoveries stays within its own ceiling', () => {
    expect(constraint('runs_recoveries_check')).toMatch(
      /CHECK \("better_trigger"\."runs"\."recoveries" >= 0 AND "better_trigger"\."runs"\."recoveries" <= "better_trigger"\."runs"\."max_recoveries"\)/,
    );
  });
});
