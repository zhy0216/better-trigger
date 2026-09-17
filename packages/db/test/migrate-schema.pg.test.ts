/* =============================================================================
   @better-trigger/db — the migration baseline against a real PostgreSQL.

   Gated on DATABASE_URL exactly like pool.test.ts's live half; skipped (not
   silently passed) without one. Each test provisions its OWN throwaway
   database off DATABASE_URL's server — never the shared one — and drops it
   afterwards, so the suite is safe to run against any scratch cluster.

   What is pinned here cannot be pinned offline:
   - a first install lands all 9 business tables, their sequences and the
     journal in "better_trigger" and NOTHING in public or the host's drizzle
     schema (journal isolation, including a pre-seeded host journal with a
     future timestamp that must neither skip our migration nor be rewritten);
   - the runtime migrator's own `CREATE SCHEMA IF NOT EXISTS` plus the
     baseline's copy do not collide;
   - a second migrate() is a no-op;
   - two independent pools (both max: 1 — the injected-host-pool shape) racing
     a first install both succeed via the advisory lock, with exactly one
     journal row per migration and no deadlock.

   Deliberately uses only `pg` + ../src/migrate: no kernel, no testing package,
   so a kernel SQL change can never mask a migration failure here.
   ============================================================================= */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const ADMIN_URL = process.env.DATABASE_URL;

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

/** Far-future journal timestamp: the drizzle migrator skips migrations whose
 *  folderMillis is <= the newest journal row, so a SHARED journal with this in
 *  it would skip the baseline — the exact host-collision being isolated from. */
const HOST_FUTURE_MILLIS = 99_999_999_999_999;

const created: string[] = [];

function tempDatabaseUrl(name: string): string {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  url.hash = '';
  return url.toString();
}

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(prefix: string): Promise<{ name: string; url: string }> {
  const name = `bt_${prefix}_${randomBytes(4).toString('hex')}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${name}`));
  created.push(name);
  return { name, url: tempDatabaseUrl(name) };
}

afterAll(async () => {
  await withAdminClient(async (client) => {
    for (const name of created) {
      // pg refuses to drop a database with live backends; the pools are ended,
      // but a lingering server-side connection must not leak the database.
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  });
});

/** Catalog reads used by the assertions — schema/name columns, not
 *  regclass::text, whose display form depends on search_path. */
async function tableNames(pool: pg.Pool, schema: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`,
    [schema],
  );
  return rows.map((r) => r.relname);
}

async function sequenceNames(pool: pg.Pool, schema: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'S'
      ORDER BY c.relname`,
    [schema],
  );
  return rows.map((r) => r.relname);
}

async function journalRows(pool: pg.Pool): Promise<{ hash: string; created_at: string }[]> {
  const { rows } = await pool.query(
    'SELECT hash, created_at FROM "better_trigger"."__drizzle_migrations" ORDER BY created_at',
  );
  return rows;
}

describe.skipIf(!ADMIN_URL)('migrate — better_trigger baseline on a real PostgreSQL', () => {
  it(
    'first install: 9 tables + journal in better_trigger, nothing in public, host journal untouched',
    async () => {
      const { url } = await createDatabase('schema');
      // max: 1 — the injected-host-pool shape the advisory lock must tolerate.
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      try {
        // A host already using the default drizzle journal, with a record NEWER
        // than our baseline: a migrator reading that table would skip ours.
        await pool.query('CREATE SCHEMA "drizzle"');
        await pool.query(
          `CREATE TABLE "drizzle"."__drizzle_migrations" (
             id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
        );
        await pool.query(
          'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
          ['host-migration', HOST_FUTURE_MILLIS],
        );

        await migrate(pool);

        // Business tables and the journal live in better_trigger — asserted
        // separately: the journal is migrator infrastructure, not a business
        // table, and must never be counted as one.
        expect(await tableNames(pool, 'better_trigger')).toEqual([
          '__drizzle_migrations',
          ...BUSINESS_TABLES,
        ]);
        expect(await tableNames(pool, 'public')).toEqual([]);
        expect(await tableNames(pool, 'drizzle')).toEqual(['__drizzle_migrations']);

        // The host journal is neither read nor rewritten.
        const { rows: hostRows } = await pool.query(
          'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"',
        );
        expect(hostRows).toEqual([
          { hash: 'host-migration', created_at: String(HOST_FUTURE_MILLIS) },
        ]);

        // Our own journal recorded the baseline exactly once.
        const journal = await journalRows(pool);
        expect(journal).toHaveLength(1);
        expect(Number(journal[0]!.created_at)).toBeLessThan(HOST_FUTURE_MILLIS);

        // bigserial sequences belong to better_trigger and to their tables
        // (pg_get_serial_sequence resolves the ownership link).
        expect(await sequenceNames(pool, 'better_trigger')).toEqual([
          '__drizzle_migrations_id_seq',
          'logs_id_seq',
          'queue_id_seq',
          'waits_id_seq',
        ]);
        for (const table of ['queue', 'waits', 'logs', '__drizzle_migrations']) {
          const { rows } = await pool.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [
            `better_trigger.${table}`,
          ]);
          expect(rows[0]!.seq).toBe(`better_trigger.${table}_id_seq`);
        }

        // Every FK's referenced table is in better_trigger too.
        const { rows: fkSchemas } = await pool.query(
          `SELECT DISTINCT rn.nspname FROM pg_constraint c
             JOIN pg_class rc ON rc.oid = c.confrelid
             JOIN pg_namespace rn ON rn.oid = rc.relnamespace
            WHERE c.contype = 'f'`,
        );
        expect(fkSchemas).toEqual([{ nspname: 'better_trigger' }]);

        // A repeat migrate is a no-op — no second journal row, no re-CREATE.
        await migrate(pool);
        expect(await journalRows(pool)).toEqual(journal);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it('two max:1 pools racing a first install both succeed, journal written once', async () => {
    const { url } = await createDatabase('race');
    const poolA = new pg.Pool({ connectionString: url, max: 1 });
    const poolB = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await expect(Promise.all([migrate(poolA), migrate(poolB)])).resolves.toEqual([
        undefined,
        undefined,
      ]);

      // Both took the advisory lock on their own pinned client; the loser
      // waited and then found nothing to do — exactly one row per migration.
      const journal = await journalRows(poolA);
      expect(journal).toHaveLength(1);
      const { rows: dupes } = await poolA.query(
        'SELECT hash, count(*) FROM "better_trigger"."__drizzle_migrations" GROUP BY hash HAVING count(*) > 1',
      );
      expect(dupes).toEqual([]);
      expect(await tableNames(poolA, 'better_trigger')).toEqual([
        '__drizzle_migrations',
        ...BUSINESS_TABLES,
      ]);
      // The winner's baseline is the only one that ran: no partial re-CREATE
      // leftovers anywhere else.
      expect(await tableNames(poolA, 'public')).toEqual([]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  }, 60_000);
});
