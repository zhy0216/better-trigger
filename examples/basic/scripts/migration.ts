/* =============================================================================
   @better-trigger/example-basic — migration install scenario (shared-database
   contract, plans/database-schema-isolation).

   better-trigger installs into its own PostgreSQL schema (`better_trigger`)
   with its own Drizzle journal (`better_trigger.__drizzle_migrations`), so a
   host project sharing the same database keeps its own `public` objects and
   its own `drizzle.__drizzle_migrations` untouched. The old 0007→latest
   upgrade replay is gone with the pre-schema migration history: a fresh
   baseline is the whole install story now. Proven here on a real Postgres:

     1. HOST JOURNAL COEXISTENCE — the host's default Drizzle journal
        (`drizzle.__drizzle_migrations`) pre-exists with a sentinel row whose
        created_at is NEWER than this project's baseline. `migrate()` must not
        read, copy, clean or rename it, and the newer host record must not
        shadow the baseline: every object is still created, in
        `better_trigger`, and the host journal's structure and rows are
        byte-identical afterwards.
     2. DEDICATED JOURNAL — `better_trigger.__drizzle_migrations` holds
        exactly one row per entry of the shipped `_journal.json`, with the
        sha256 hash and folderMillis drizzle computes; the nine business
        tables and their sequences all live in `better_trigger`; `public`
        gained nothing.
     3. REPEAT INSTALL — re-running `migrate()` is a no-op: the journal is
        unchanged and no object is re-created.
     4. CONCURRENT INSTALL — two independent `max: 1` pools racing the FIRST
        install on a second scratch database both succeed (the pinned-client
        advisory lock serializes them); the journal ends with exactly one row
        and the full object set.

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_MIGRATE_DB     override the database name prefix (default
                       better_trigger_migrate)
   ============================================================================= */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@better-trigger/db';
import { resetDb, runScenario, type Scenario, type TestDatabase } from '@better-trigger/testing';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../packages/db/migrations', import.meta.url),
);

/** The nine business tables the baseline must create, in `better_trigger`. */
const BUSINESS_TABLES = [
  'logs',
  'queue',
  'run_retry_operations',
  'run_steps',
  'runs',
  'schedules',
  'tasks',
  'waits',
  'workers',
];

interface JournalEntry {
  tag: string;
  when: number;
}

function journalEntries(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8'),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

const count = async (s: Scenario, sql: string, params: unknown[] = []): Promise<number> => {
  const res = await s.pool.query<{ count: string }>(sql, params);
  return Number(res.rows[0]?.count ?? 0);
};

/** The host journal's shape: columns (ordered) plus every row, verbatim. */
async function hostJournalSnapshot(s: Scenario): Promise<string> {
  const columns = await s.pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
      ORDER BY ordinal_position`,
  );
  const rows = await s.pool.query(
    `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  return JSON.stringify({ columns: columns.rows, rows: rows.rows });
}

/** Assert the baseline installed completely, in `better_trigger` only. */
async function assertInstalled(s: Scenario, label: string): Promise<void> {
  const tables = await s.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'better_trigger' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  s.assertEqual(
    tables.rows.map((r) => r.table_name),
    [...BUSINESS_TABLES, '__drizzle_migrations'].sort(),
    `${label}: better_trigger holds the nine business tables and the journal`,
  );
  // bigserial sequences belong to their tables, inside the schema.
  for (const [table, column] of [['queue', 'id'], ['waits', 'id'], ['logs', 'id']] as const) {
    const seq = await s.pool.query<{ seq: string | null }>(
      `SELECT pg_get_serial_sequence($1, $2) AS seq`,
      [`better_trigger.${table}`, column],
    );
    s.assert(
      seq.rows[0]?.seq === `better_trigger.${table}_${column}_seq`,
      `${label}: better_trigger.${table}.${column} sequence ownership, got ${String(seq.rows[0]?.seq)}`,
    );
  }
  const journalRows = await s.pool.query<{ created_at: string | number }>(
    `SELECT created_at FROM better_trigger.__drizzle_migrations`,
  );
  // One row per shipped migration, and only rows for shipped migrations.
  const expected = journalEntries().map((e) => String(e.when)).sort();
  s.assertEqual(
    journalRows.rows.map((r) => String(r.created_at)).sort(),
    expected,
    `${label}: dedicated journal holds exactly one row per migration`,
  );
  const publicRelations = await count(
    s,
    `SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')`,
  );
  s.assertEqual(publicRelations, 0, `${label}: public gained no relation`);
}

async function main(s: Scenario): Promise<void> {
  const entries = journalEntries();
  // A host record NEWER than the baseline: with a shared journal this is
  // exactly what would make drizzle skip the install.
  const sentinelWhen = Math.max(...entries.map((e) => e.when)) + 86_400_000;

  /* -- 1. the host's own Drizzle journal pre-exists, with a newer record ---- */
  let hostBefore = '';
  await s.check('a newer host Drizzle journal does not shadow the baseline install', async () => {
    await s.pool.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await s.pool.query(
      `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
         "id" serial PRIMARY KEY,
         "hash" text NOT NULL,
         "created_at" bigint
       )`,
    );
    await s.pool.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      ['host-sentinel-migration-hash', sentinelWhen],
    );
    hostBefore = await hostJournalSnapshot(s);

    await migrate(s.pool);

    await assertInstalled(s, 'first install');
    // The host journal is the migrator's no-go zone: same shape, same rows.
    s.assertEqual(await hostJournalSnapshot(s), hostBefore, 'host journal untouched by migrate()');
  });

  /* -- 2. the dedicated journal row IS the shipped migration ---------------- */
  await s.check('the dedicated journal records the shipped baseline exactly', async () => {
    const rows = await s.pool.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at FROM better_trigger.__drizzle_migrations ORDER BY created_at`,
    );
    s.assertEqual(rows.rows.length, entries.length, 'one journal row per migration');
    for (const [i, entry] of entries.entries()) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${entry.tag}.sql`, 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      s.assertEqual(rows.rows[i]?.hash, hash, `${entry.tag} hash`);
      s.assertEqual(Number(rows.rows[i]?.created_at), entry.when, `${entry.tag} created_at`);
    }
    // The installed objects are usable: a write/read round-trip through the
    // real FK graph (queue → runs → tasks).
    await s.pool.query(`INSERT INTO better_trigger.tasks (id, name) VALUES ('mig-task', 'mig-task')`);
    await s.pool.query(
      `INSERT INTO better_trigger.runs (id, task_id, status, trigger_type, payload, created_at, updated_at)
       VALUES ('run_new', 'mig-task', 'completed', 'api', '{"user":"u_new"}'::jsonb, now(), now())`,
    );
    await s.pool.query(
      `INSERT INTO better_trigger.queue (run_id, available_at) VALUES ('run_new', now())`,
    );
    const run = await s.pool.query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM better_trigger.runs WHERE id = 'run_new'`,
    );
    s.assertEqual(run.rows[0]?.status, 'completed', 'baseline tables accept writes');
    s.assertEqual(run.rows[0]?.payload, { user: 'u_new' }, 'baseline tables read back');
  });

  /* -- 3. re-running migrate() is a no-op ------------------------------------ */
  await s.check('re-running migrate() is a no-op', async () => {
    await migrate(s.pool);
    const journal = await count(s, `SELECT count(*) FROM better_trigger.__drizzle_migrations`);
    s.assertEqual(journal, entries.length, 'journal unchanged by the second migrate');
    await assertInstalled(s, 'repeat install');
    s.assertEqual(await hostJournalSnapshot(s), hostBefore, 'host journal untouched by the repeat');
  });

  /* -- 4. two max:1 pools race the FIRST install ----------------------------- */
  let concurrent: TestDatabase | undefined;
  await s.check('two max:1 pools install concurrently, once', async () => {
    concurrent = await resetDb({
      name: 'better_trigger_migrate_conc',
      envVar: 'BT_MIGRATE_CONC_DB',
      migrate: false,
    });
    s.cleanup(() => concurrent?.drop());
    const first = createPool(concurrent.url, { error: () => {} }, { max: 1 });
    const second = createPool(concurrent.url, { error: () => {} }, { max: 1 });
    try {
      await Promise.all([migrate(first), migrate(second)]);
      const tables = await first.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'better_trigger' AND table_type = 'BASE TABLE'`,
      );
      s.assertEqual(
        tables.rows.map((r) => r.table_name).sort(),
        [...BUSINESS_TABLES, '__drizzle_migrations'].sort(),
        'concurrent install created the full object set',
      );
      const journal = await first.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM better_trigger.__drizzle_migrations`,
      );
      s.assertEqual(journal.rows[0]?.n, entries.length, 'journal has exactly one row per migration');
    } finally {
      await Promise.allSettled([first.end(), second.end()]);
    }
  });
}

await runScenario(
  {
    name: 'migration',
    what: 'baseline install beside a newer host Drizzle journal; repeat and concurrent installs stay no-op/once',
    // The install itself is under test, so resetDb must NOT migrate first.
    db: { name: 'better_trigger_migrate', envVar: 'BT_MIGRATE_DB', migrate: false },
  },
  main,
);
