/* =============================================================================
   @better-trigger/db — startup migration.
   Applies the drizzle-kit-generated SQL in ../migrations (tracked in the
   drizzle.__drizzle_migrations journal table). Idempotent: safe on every boot.
   Regenerate migrations after schema.ts changes with `bun run db:generate`.
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

// Resolves to <package root>/migrations from both src/ (dev) and dist/ (built);
// tsup `shims: true` provides import.meta.url for the cjs build.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/* Advisory-lock key for the migration itself, in the two-argument
   (classid, objid) key space. classid spells 'btmg' (better-trigger migrate);
   objid leaves room for further migration locks. The kernel's concurrency
   limiter is in the same two-argument space but under its own classid ('btcc',
   CONCURRENCY_LOCK_CLASS in packages/kernel/src/queue.ts), so the two objid
   spaces are disjoint and can never collide. That one is also transaction
   scoped; this one is session scoped, hence the manual unlock below. */
const LOCK_CLASS = 0x62_74_6d_67; // 'btmg'
const LOCK_OBJECT = 1;

/** Apply pending migrations. Called once at server boot before listening. */
export async function migrate(pool: pg.Pool): Promise<void> {
  // Daemons share one database and every one of them migrates on boot, so two
  // can enter drizzle's migrator at the same instant — it takes no lock of its
  // own, and the concurrent CREATE of drizzle.__drizzle_migrations plus the
  // duplicate journal inserts then fail at random. Serialize on an advisory
  // lock: the loser waits for the winner and finds nothing left to do.
  // pg_advisory_lock is *session*-scoped, so it must be taken and released on
  // one pinned client — pool.query() would hand the unlock to whichever client
  // happens to be idle, releasing nothing and stranding the real holder's lock
  // for the life of the process. Running the migration on that same client also
  // keeps this deadlock-free on a caller-supplied pool with max: 1.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_CLASS, LOCK_OBJECT]);
    try {
      await drizzleMigrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      // Swallowed on purpose: if the migration failed because the connection
      // died, this unlock dies with it, and a throw here would replace the
      // migration error with a connection error — hiding the root cause behind
      // its own symptom. Releasing the client below ends that session anyway,
      // which is what actually drops a session-scoped advisory lock.
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_OBJECT])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}
