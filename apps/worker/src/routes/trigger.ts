/* =============================================================================
   @better-trigger/worker — trigger API (app code / dashboard).
   POST /trigger · POST /batch-trigger
   Thin HTTP shims over the injected kernel (validation lives in the kernel;
   bad shapes surface as KernelError('bad_request') → 400 via app.onError).
   See docs/backend-contract.md §4.
   ============================================================================= */
import { Hono } from 'hono';
import type { Kernel } from '@better-trigger/kernel';
import type {
  BatchTriggerRequest,
  BatchTriggerResponse,
  TriggerRequest,
  TriggerResponse,
} from '../types';

export function triggerRoutes(deps: { kernel: Kernel }): Hono {
  const { kernel } = deps;
  const app = new Hono();

  /* ---------------------------------------------------------- /trigger */
  app.post('/trigger', async (c) => {
    const body = await c.req.json<TriggerRequest>();
    const created = await kernel.trigger({
      taskId: body.taskId,
      payload: body.payload,
      options: body.options,
    });
    const res: TriggerResponse = { runId: created.runId, idempotent: created.idempotent };
    return c.json(res);
  });

  /* ---------------------------------------------------- /batch-trigger */
  app.post('/batch-trigger', async (c) => {
    const body = await c.req.json<BatchTriggerRequest>();
    const { runIds } = await kernel.batchTrigger(body.items);
    const res: BatchTriggerResponse = { runIds };
    return c.json(res);
  });

  return app;
}
