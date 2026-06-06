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

/** Apply pending migrations. Called once at server boot before listening. */
export async function migrate(pool: pg.Pool): Promise<void> {
  await drizzleMigrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
}
