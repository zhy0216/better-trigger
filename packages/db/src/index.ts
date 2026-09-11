/* =============================================================================
   @better-trigger/db — package surface.
   schema (single source of truth for the DB shape), generated-migration
   runner, and the pg Pool factory.
   ============================================================================= */
export * from './schema';
export {
  createPool,
  createHealthPool,
  DEFAULT_DATABASE_URL,
  type PoolLogger,
  type PoolOptions,
} from './pool';
export { migrate } from './migrate';
