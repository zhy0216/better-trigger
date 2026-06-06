/* =============================================================================
   @better-trigger/example-basic — worker entrypoint.

   Registers every example task with the server, then long-polls for runs and
   executes them via the replay engine. Heartbeat and graceful shutdown
   (SIGINT/SIGTERM) are handled inside startWorker.

   Points at BETTER_TRIGGER_API_URL (default http://localhost:4848).
   Run with: bun src/worker.ts   (alias: bun run worker)
   ============================================================================= */
import { startWorker } from 'better-trigger';
import { allTasks } from './tasks';

await startWorker({
  tasks: allTasks,
  concurrency: 5,
});
