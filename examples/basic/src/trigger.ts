/* =============================================================================
   @better-trigger/example-basic — the better-trigger client.

   This is what application code holds: an HTTP client pointed at the worker
   daemon. No database connection, no execution loop. Start the daemon with

     bun run worker        # better-trigger-worker --tasks src/tasks.ts

   and it will load ./tasks.ts and run whatever this client triggers.

   Points at BETTER_TRIGGER_URL (default http://localhost:4848).
   ============================================================================= */
import { betterTrigger } from 'better-trigger';

export const trigger = betterTrigger({
  url: process.env.BETTER_TRIGGER_URL ?? 'http://localhost:4848',
});
