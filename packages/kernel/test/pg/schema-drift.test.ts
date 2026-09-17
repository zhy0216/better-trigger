/* =============================================================================
    schema-drift probe — guards the IMPLICIT contract between
    @better-trigger/db's schema.ts and the kernel's hand-written assumptions
    (todos/p1-07).

    schema.ts claims to be the SINGLE SOURCE OF TRUTH for the database shape,
    but that claim only holds for migrations: the kernel hand-writes its own
    snake_case row types (RunRow & co), writes `better_trigger.<table>` into
    every statement by hand, and hard-codes a pg constraint name
    (RETRY_OPERATION_UNIQUE_CONSTRAINT, which depends on pg truncating
    identifiers to 63 bytes) — nothing at compile time ties any of them to
    schema.ts. `db:generate` will happily emit a migration that renames a
    column, moves a table to another schema, or changes a constraint while the
    kernel keeps querying the old shape — that drift ships silently and fails
    at runtime, in production.

    This probe compares the EXPECTED shape (derived from the same Drizzle
    table objects schema.ts defines: schema/name, columns, defaults, checks,
    PKs, indexes, serial sequences) against the LIVE database (freshly
    provisioned + migrated via withPg) and fails with a diff when they
    disagree — so any schema change that the kernel has not been updated for
    breaks CI in the true-PG job instead of a customer's queue.

    Catalog reads use the schema/name columns of pg_class + pg_namespace (or
    information_schema), never `regclass::text`: the display form of a
    regclass depends on the session's search_path, which this probe must not
    care about. The migrator's journal (`better_trigger.__drizzle_migrations`,
    db's MIGRATIONS_TABLE) is infrastructure, not a business table — it is
    asserted separately and excluded from the 9-table set.

    Gated on DATABASE_URL like every suite in this directory; skipped
    otherwise (bun run test stays DB-free on a machine without Postgres).
    ============================================================================= */
import { expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  DB_SCHEMA,
  MIGRATIONS_TABLE,
  logs,
  queue,
  runRetryOperations,
  runSteps,
  runs,
  schedules,
  tasks,
  waits,
  workers,
} from '../../../db/src/index';
import { describePg, withPg } from './helpers';
import { RETRY_OPERATION_UNIQUE_CONSTRAINT } from '../../src/runs';

/** The 9 business tables schema.ts defines. The drizzle journal lives in the
 *  same schema but is NOT one of them — it is handled separately below. */
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

/** Every model table must declare the same schema — the one the kernel's
 *  hand-written `better_trigger.<table>` references name. Derived from the
 *  model metadata (not a literal) so a schema rename fails here as drift
 *  against the live database AND against DB_SCHEMA below. */
const MODEL_SCHEMAS = new Set(
  Object.values(EXPECTED_TABLES).map((t) => getTableConfig(t).schema),
);

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

type Column = ReturnType<typeof getTableConfig>['columns'][number];

/** Strip the schema qualification inside a `nextval('…'::regclass)` default:
 *  whether pg renders the regclass schema-qualified depends on search_path,
 *  which is exactly the display dependency this probe must not have. */
function normalizeDefault(text: string): string {
  return text.replace(/nextval\('(?:[^']+\.)?([^']+)'\)/, `nextval('$1')`);
}

/** The column_default text the live catalog must report for a model column,
 *  rendered from drizzle's own metadata (null when the column has none). */
function expectedDefault(schema: string, tableName: string, col: Column): string | null {
  if (!col.hasDefault) return null;
  const sqlType = col.getSQLType();
  const d = col.default;
  if (d === undefined) {
    // serial family: the migration wires the owned sequence as the default.
    if (/serial/i.test(sqlType)) {
      return `nextval('${schema}.${tableName}_${col.name}_seq'::regclass)`;
    }
    throw new Error(`column ${tableName}.${col.name} has a default drizzle cannot show`);
  }
  if (typeof d === 'string') return `'${d}'::${sqlType}`;
  if (typeof d === 'number' || typeof d === 'boolean') return String(d);
  // SQL chunks (defaultNow(), the workers.namespaces jsonb literal): the
  // baseline renders them verbatim, so their StringChunk text IS the expected
  // default expression. Anything else (a Param chunk) is a shape this
  // renderer refuses to guess at.
  const chunks = (d as { queryChunks?: Array<{ value?: string[] }> }).queryChunks ?? [];
  const parts = chunks.map((c) => {
    if (!Array.isArray(c.value)) {
      throw new Error(`column ${tableName}.${col.name} has a default this probe cannot render`);
    }
    return c.value.join('');
  });
  return parts.join('');
}

/** Compare one live column_default against the rendered model default. jsonb
 *  literals compare parsed and key-order-insensitively: pg re-renders a jsonb
 *  const through its output function (whitespace-normalized, keys in jsonb's
 *  own order), so byte equality of the literal would test pg's printer, not
 *  the schema. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function defaultsEqual(expected: string | null, live: string | null): boolean {
  if (expected === null || live === null) return expected === live;
  const e = normalizeDefault(expected);
  const l = normalizeDefault(live);
  if (e === l) return true;
  const jsonb = /^'([\s\S]*)'::jsonb$/;
  const em = jsonb.exec(e);
  const lm = jsonb.exec(l);
  if (em && lm) {
    try {
      return canonicalJson(JSON.parse(em[1]!)) === canonicalJson(JSON.parse(lm[1]!));
    } catch {
      return false;
    }
  }
  return false;
}

describePg('schema drift', () => {
  it('live database matches the shape schema.ts declares', async () => {
    // The model itself must declare the fixed schema the kernel hard-codes in
    // its `better_trigger.<table>` SQL — checked before any database read, so
    // a model/schema rename cannot quietly agree with a re-provisioned DB.
    expect([...MODEL_SCHEMAS]).toEqual([DB_SCHEMA]);

    await withPg('schema_drift', async ({ pool }) => {
      // One catalog read for table names, by (schema, name) columns — no
      // regclass::text, whose display form depends on search_path.
      const rels = await pool.query<{ relname: string; relkind: string }>(
        `SELECT c.relname, c.relkind FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r','S')
          ORDER BY c.relname`,
        [DB_SCHEMA],
      );
      const liveTables = rels.rows.filter((r) => r.relkind === 'r').map((r) => r.relname);
      const liveSequences = rels.rows.filter((r) => r.relkind === 'S').map((r) => r.relname);
      // The journal is migrator infrastructure: asserted separately, never
      // counted among the business tables.
      const liveBusinessTables = liveTables.filter((t) => t !== MIGRATIONS_TABLE);

      const columns = await pool.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name <> $2`,
        [DB_SCHEMA, MIGRATIONS_TABLE],
      );

      // Constraint rows by (schema, table) name columns, not conrelid::text.
      const constraints = await pool.query<{
        table_name: string;
        conname: string;
        contype: string;
      }>(
        `SELECT c.relname AS table_name, con.conname, con.contype
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.contype IN ('c','p','u') AND n.nspname = $1`,
        [DB_SCHEMA],
      );

      // Live indexes per table, split into constraint-backing ones (PK/unique,
      // covered by the constraint assertions) and the declared secondary
      // indexes (compared against getTableConfig().indexes below).
      const indexes = await pool.query<{ tablename: string; indexname: string }>(
        `SELECT i.tablename, i.indexname
           FROM pg_indexes i
          WHERE i.schemaname = $1`,
        [DB_SCHEMA],
      );
      const constraintIndexNames = await pool.query<{ indexname: string }>(
        `SELECT c.relname AS indexname
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conindid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1`,
        [DB_SCHEMA],
      );
      const constraintBacked = new Set(constraintIndexNames.rows.map((r) => r.indexname));

      // 1. The better_trigger schema holds exactly the 9 business tables, no
      //    more, no fewer (a schema.ts table added/removed/renamed shows up
      //    here), and the journal is handled on its own.
      expect(liveBusinessTables.sort()).toEqual(Object.keys(EXPECTED_TABLES).sort());
      expect(liveTables).toContain(MIGRATIONS_TABLE);

      // Every FK the 9 tables carry references a table in the SAME schema —
      // the kernel's qualified SQL and the cascades prune relies on cannot
      // reach outside better_trigger.
      const fkSchemas = await pool.query<{ nspname: string }>(
        `SELECT DISTINCT rn.nspname
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_class rc ON rc.oid = con.confrelid
           JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          WHERE con.contype = 'f' AND n.nspname = $1`,
        [DB_SCHEMA],
      );
      expect(fkSchemas.rows).toEqual([{ nspname: DB_SCHEMA }]);

      // The schema's sequences are exactly the serial-owned ones: one per
      // bigserial column of the business tables, plus the journal's own.
      // Ownership (pg_get_serial_sequence) is checked per column below.
      const expectedSequences = [`${MIGRATIONS_TABLE}_id_seq`];
      for (const [tableName, table] of Object.entries(EXPECTED_TABLES)) {
        for (const col of getTableConfig(table).columns) {
          if (/serial/i.test(col.getSQLType())) expectedSequences.push(`${tableName}_${col.name}_seq`);
        }
      }
      expect([...liveSequences].sort()).toEqual(expectedSequences.sort());

      for (const [tableName, table] of Object.entries(EXPECTED_TABLES)) {
        const cfg = getTableConfig(table);
        expect(cfg.schema, `${tableName} model schema`).toBe(DB_SCHEMA);

        // 2. Column set + nullability + defaults: the kernel's SELECT lists,
        //    its not-null reads (e.g. RunRow fields) and its INSERT column
        //    lists (which omit every defaulted column) assume these exactly.
        const liveCols = columns.rows
          .filter((r) => r.table_name === tableName)
          .map((r) => [r.column_name, r.is_nullable === 'NO'] as const);
        const expectedCols = cfg.columns.map((c) => [c.name, c.notNull] as const);
        expect(new Map(liveCols), `${tableName} columns`).toEqual(new Map(expectedCols));

        for (const col of cfg.columns) {
          const live = columns.rows.find(
            (r) => r.table_name === tableName && r.column_name === col.name,
          );
          const expected = expectedDefault(DB_SCHEMA, tableName, col);
          expect(
            defaultsEqual(expected, live?.column_default ?? null),
            `${tableName}.${col.name} default: expected ${expected}, live ${live?.column_default ?? null}`,
          ).toBe(true);
          // Serial defaults render a nextval; ownership is the real check.
          if (expected !== null && /serial/i.test(col.getSQLType())) {
            const owned = await pool.query<{ seq: string | null }>(
              `SELECT pg_get_serial_sequence($1, $2) AS seq`,
              [`${DB_SCHEMA}.${tableName}`, col.name],
            );
            expect(owned.rows[0]!.seq, `${tableName}.${col.name} sequence`).toBe(
              `${DB_SCHEMA}.${tableName}_${col.name}_seq`,
            );
          }
        }

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

        // 5. Secondary indexes: every index schema.ts declares exists live by
        //    name, and the table carries no undeclared non-constraint index —
        //    the kernel's hot loops (claim scan, reaper, cron, wake, log page)
        //    are built around exactly these shapes (plans.test.ts pins the
        //    plans themselves).
        const liveIdx = indexes.rows
          .filter((r) => r.tablename === tableName && !constraintBacked.has(r.indexname))
          .map((r) => r.indexname)
          .sort();
        const expectedIdx = cfg.indexes.map((i) => truncate(i.config.name!)).sort();
        expect(liveIdx, `${tableName} indexes`).toEqual(expectedIdx);
      }

      // 6. The kernel's hand-written constant: isUniqueViolation matches
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
