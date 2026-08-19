/* =============================================================================
   @better-trigger/example-basic — no separate daemon process.

   The application hosts the same worker runtime in-process. It still needs a
   long-lived Node/Bun lifecycle: if this process stops, Postgres retains the
   durable state but no task/timer/cron executes until a runtime returns.
   ============================================================================= */
import { createEmbeddedRuntime } from '@better-trigger/worker/embedded';
import { allTasks, helloWorld } from './tasks';

const runtime = await createEmbeddedRuntime({
  databaseUrl: process.env.DATABASE_URL,
  tasks: allTasks,
  concurrency: 5,
});

try {
  const handle = await helloWorld.trigger({ name: 'embedded' });
  console.log(await handle.result());
} finally {
  await runtime.stop();
}
