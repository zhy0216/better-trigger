/* =============================================================================
   @better-trigger/db — pg Pool factory.
   The package does not hold a connection itself; callers create (and own) the
   pool, which keeps the surface injectable for tests and embedded use.
   ============================================================================= */
import pg from 'pg';

const { Pool } = pg;

export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/better_trigger';

export function createPool(
  connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): pg.Pool {
  return new Pool({ connectionString });
}
