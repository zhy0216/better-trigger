/* =============================================================================
   @better-trigger/db — fixed PostgreSQL object names.
   Every better-trigger table, index and sequence lives in DB_SCHEMA, which is
   independent of the database name so the host project can keep its own
   `public` tables and its own Drizzle journal (`drizzle.__drizzle_migrations`)
   untouched. This project's migration journal is DB_SCHEMA.MIGRATIONS_TABLE.
   ============================================================================= */

/** PostgreSQL schema holding every better-trigger object. */
export const DB_SCHEMA = 'better_trigger';

/** Drizzle migration journal table name, inside DB_SCHEMA. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';
