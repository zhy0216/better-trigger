/* =============================================================================
   @better-trigger/server — process entry point.
   migrate → orchestrator.start → serve. Graceful shutdown on SIGINT/SIGTERM.
   bin: better-trigger-server (see package.json + tsup banner).
   ============================================================================= */
import { serve } from '@hono/node-server';
import { migrate } from '@better-trigger/db';
import { createApp } from './app';
import { pool } from './db/index';
import { createOrchestrator } from './engine/orchestrator';

const PORT = Number(process.env.PORT ?? 4848);

async function main(): Promise<void> {
  await migrate(pool);

  const orchestrator = createOrchestrator();
  orchestrator.start();

  const app = createApp();
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
