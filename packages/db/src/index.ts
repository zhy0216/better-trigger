/* =============================================================================
   @better-trigger/db — package surface.
   schema (single source of truth for the DB shape), generated-migration
   runner, and the pg Pool factory.
   ============================================================================= */
export * as schema from './schema';
export * from './schema';
export { createPool, DEFAULT_DATABASE_URL, type PoolLogger } from './pool';
export { migrate } from './migrate';
