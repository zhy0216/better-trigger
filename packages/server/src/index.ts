/* =============================================================================
   @better-trigger/server — library surface.
   Exports the app factory, db handles, orchestrator and migration so the
   package can be embedded/tested. The runnable process entry is src/main.ts.
   ============================================================================= */
export { createApp, type AppDeps } from './app';
export { migrate, schema } from '@better-trigger/db';
export { pool, DATABASE_URL } from './db/index';
export { createOrchestrator, type Orchestrator, nextCronAt } from './engine/orchestrator';
export { HttpError } from './engine/runs';
