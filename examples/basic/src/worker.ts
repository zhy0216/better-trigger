/* =============================================================================
   @better-trigger/example-basic — worker entrypoint (embedded runtime).

   Registers every example task on the shared instance, then claims and
   executes runs in-process — no server, no HTTP. Orchestrator loops
   (waits / cron / reaper), heartbeat and graceful shutdown (SIGINT/SIGTERM)
   are handled inside trigger.start().

   Run with: bun src/worker.ts   (alias: bun run worker)
   ============================================================================= */
import { trigger } from './trigger';
import { allTasks } from './tasks';

await trigger.start({
  tasks: allTasks,
  concurrency: 5,
});
