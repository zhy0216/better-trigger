/* =============================================================================
   @better-trigger/server — process entry point (dashboard API only).
   pool → migrate → createKernel → createApp → serve. No orchestrator here —
   background loops run inside embedded workers (betterTrigger().start()).
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
  const app = createApp({ kernel, pool });
  const server = serve({ fetch: app.fetch, port: PORT });

  console.log(`[better-trigger] server listening on http://localhost:${PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[better-trigger] ${signal} received, shutting down...`);
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
