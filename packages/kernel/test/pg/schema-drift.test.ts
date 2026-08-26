/* =============================================================================
   schema-drift probe — guards the IMPLICIT contract between
   @better-trigger/db's schema.ts and the kernel's hand-written assumptions
   (todos/p1-07).

   schema.ts claims to be the SINGLE SOURCE OF TRUTH for the database shape,
   but that claim only holds for migrations: the kernel hand-writes its own
   snake_case row types (RunRow & co) and hard-codes a pg constraint name
   (RETRY_OPERATION_UNIQUE_CONSTRAINT, which depends on pg truncating
   identifiers to 63 bytes), and nothing at compile time ties them to
   schema.ts. `db:generate` will happily emit a migration that renames a
   column or changes a constraint while the kernel keeps querying the old
   name — that drift ships silently and fails at runtime, in production.

   This probe compares the EXPECTED shape (derived from the same Drizzle
   table objects schema.ts defines) against the LIVE database (freshly
   provisioned + migrated via withPg) and fails with a diff when they
   disagree — so any schema change that the kernel has not been updated for
   breaks CI in the true-PG job instead of a customer's queue.

   Gated on DATABASE_URL like every suite in this directory; skipped
   otherwise (bun run test stays DB-free on a machine without Postgres).
   ============================================================================= */
import { expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  logs,
  queue,
  runRetryOperations,
  runSteps,
  runs,
  schedules,
  tasks,
  waits,
  workers,
} from '@better-trigger/db';
import { describePg, withPg } from './helpers';
import { RETRY_OPERATION_UNIQUE_CONSTRAINT } from '../../src/runs';

/** The 9 business tables schema.ts defines (drizzle's journal table lives in
 *  its own `drizzle` schema, so public is exactly these). */
type DrizzleTable = Parameters<typeof getTableConfig>[0];
const EXPECTED_TABLES: Record<string, DrizzleTable> = {
  tasks,
  runs,
  run_retry_operations: runRetryOperations,
  run_steps: runSteps,
  queue,
  waits,
  logs,
  schedules,
  workers,
};

/** pg truncates all identifiers to 63 bytes (NAMEDATALEN-1) — expected names
 *  must be truncated the same way before comparing against the live catalog. */
function truncate(name: string): string {
  return name.slice(0, 63);
}

/** The name the LIVE database will report for a table's primary key:
 *  - multi-column PK (schema.ts `primaryKey({ columns })` extras): drizzle
 *    emits CONSTRAINT "<table>_<cols joined '_'>_pk" (explicitly named PKs
 *    keep their explicit name);
 *  - single-column PK (column-level `.primaryKey()`): the migration leaves it
 *    inline and pg auto-names it "<table>_pkey". */
function expectedPkName(table: DrizzleTable): string {
  const cfg = getTableConfig(table);
  const pk = cfg.primaryKeys[0];
  if (pk) {
    if (pk.name) return truncate(pk.name);
    const cols = pk.columns.map((c) => c.name).join('_');
    return truncate(`${cfg.name}_${cols}_pk`);
  }
  return truncate(`${cfg.name}_pkey`);
}

describePg('schema drift', () => {
  it('live database matches the shape schema.ts declares', async () => {
    await withPg('schema_drift', async ({ pool }) => {
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const liveTables = tables.rows.map((r) => r.table_name);

      const columns = await pool.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns WHERE table_schema = 'public'`,
      );

      const constraints = await pool.query<{
        table_name: string;
        conname: string;
        contype: string;
      }>(
        `SELECT conrelid::regclass::text AS table_name, conname, contype
         FROM pg_constraint
         WHERE contype IN ('c','p','u') AND connamespace = 'public'::regnamespace`,
      );

      // 1. The public schema holds exactly the 9 business tables, no more, no
      //    fewer (a schema.ts table added/removed/renamed shows up here).
      expect(liveTables).toEqual(Object.keys(EXPECTED_TABLES).sort());

      for (const [tableName, table] of Object.entries(EXPECTED_TABLES)) {
        const cfg = getTableConfig(table);

        // 2. Column set + nullability: the kernel's SELECT lists and its
        //    not-null reads (e.g. RunRow fields) assume these exactly.
        const liveCols = columns.rows
          .filter((r) => r.table_name === tableName)
          .map((r) => [r.column_name, r.is_nullable === 'NO'] as const);
        const expectedCols = cfg.columns.map((c) => [c.name, c.notNull] as const);
        expect(new Map(liveCols), `${tableName} columns`).toEqual(new Map(expectedCols));

        // 3. CHECK constraints: closed enums / bounds the kernel relies on
        //    (status/kind/level sets) — name drift means the guard moved or
        //    was removed.
        const liveChecks = constraints.rows
          .filter((r) => r.table_name === tableName && r.contype === 'c')
          .map((r) => r.conname)
          .sort();
        const expectedChecks = cfg.checks.map((c) => truncate(c.name)).sort();
        expect(liveChecks, `${tableName} check constraints`).toEqual(expectedChecks);

        // 4. PRIMARY KEY: exactly one, under the name drizzle/pg derives from
        //    schema.ts (truncated to 63 bytes).
        const livePks = constraints.rows.filter(
          (r) => r.table_name === tableName && r.contype === 'p',
        );
        expect(livePks.map((r) => r.conname), `${tableName} primary key`).toEqual([
          expectedPkName(table),
        ]);
      }

      // 5. The kernel's hand-written constant: isUniqueViolation matches
      //    err.constraint against RETRY_OPERATION_UNIQUE_CONSTRAINT — if a
      //    schema.ts edit changes run_retry_operations' PK columns/name (and
      //    thus the truncated live name), this fails immediately instead of
      //    silently treating a retry race as a fresh run (or vice versa).
      const liveRetryPk = constraints.rows.find(
        (r) => r.table_name === 'run_retry_operations' && r.contype === 'p',
      );
      expect(liveRetryPk?.conname).toBe(RETRY_OPERATION_UNIQUE_CONSTRAINT);
    });
  });
});
