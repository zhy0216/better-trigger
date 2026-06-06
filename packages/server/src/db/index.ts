/* =============================================================================
   @better-trigger/server — pg Pool + drizzle instance.
   ============================================================================= */
import pg from 'pg';

const { Pool } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger';

export const pool = new Pool({ connectionString: DATABASE_URL });

export * as schema from './schema';
