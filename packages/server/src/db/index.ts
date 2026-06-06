/* =============================================================================
   @better-trigger/server — process-wide pg Pool, created via @better-trigger/db.
   ============================================================================= */
import { createPool, DEFAULT_DATABASE_URL } from '@better-trigger/db';

export const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

export const pool = createPool(DATABASE_URL);
