/* =============================================================================
   @better-trigger/server — run control routes (dashboard).
   POST /runs/:id/cancel · POST /runs/:id/retry
   Worker reporting moved in-process (embedded SDK talks to the kernel
   directly); only the dashboard control paths remain over HTTP.
   See docs/backend-contract.md §5.
   ============================================================================= */
import { Hono } from 'hono';
import type { Kernel } from '@better-trigger/core';
import type { OkResponse, RetryRunResponse } from '../types';

export function runRoutes(deps: { kernel: Kernel }): Hono {
  const { kernel } = deps;
  const app = new Hono();

  /* -------------------------------------------------------- cancel */
  app.post('/runs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    await kernel.cancelRun(id);
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* --------------------------------------------------------- retry */
  app.post('/runs/:id/retry', async (c) => {
    const id = c.req.param('id');
    const { runId } = await kernel.retryRun(id);
    const res: RetryRunResponse = { runId };
    return c.json(res);
  });

  return app;
}
