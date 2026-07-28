/* =============================================================================
   @better-trigger/server — process entry point (dashboard API only).
   pool → migrate → createKernel → createApp → serve. Execution loops (waits /
   cron) run inside embedded workers (betterTrigger().start()); this process
   runs only the bookkeeping loops — lease reaper + worker offline marker — so
   leases are reaped and dead workers marked offline even when every embedded
   worker process is gone, without the server becoming an execution scheduler.
   Graceful shutdown on SIGINT/SIGTERM.
   bin: better-trigger-server (see package.json + tsup banner).
   ============================================================================= */
import { serve } from '@hono/node-server';
import { createKernel } from '@better-trigger/core';
import { createPool, migrate } from '@better-trigger/db';
import { createApp } from './app';

const PORT = Number(process.env.PORT ?? 4848);

async function main(): Promise<void> {
  const pool = createPool(); // defaults to process.env.DATABASE_URL
  await migrate(pool);

  const kernel = createKernel({ pool });
  // Bookkeeping loops only: reap expired leases and mark dead workers offline
  // even when no embedded worker process is alive. waits/cron stay off — the
  // dashboard server must not become an execution scheduler.
  const orchestrator = kernel.startOrchestrator({
    waits: false,
    cron: false,
    reaper: true,
    workerOffline: true,
  });
  const app = createApp({ kernel, pool });
  const server = serve({ fetch: app.fetch, port: PORT });

  console.log(`[better-trigger] server listening on http://localhost:${PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[better-trigger] ${signal} received, shutting down...`);
    orchestrator.stop();
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[better-trigger] fatal:', err);
  process.exit(1);
});
