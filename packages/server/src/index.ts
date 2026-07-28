/* =============================================================================
   @better-trigger/server — library surface (studio face).
   Exports the app factory, db handles and the dashboard REST types so the
   package can be embedded/tested. The runnable process entry is src/main.ts.
   ============================================================================= */
export { createApp, type AppDeps } from './app';
export { createPool, DEFAULT_DATABASE_URL, migrate, schema } from '@better-trigger/db';
export * from './types';
