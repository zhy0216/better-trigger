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
import { safeJson } from '../http';
import { namespaceFromOptions } from '../namespace';

export function triggerRoutes(deps: { kernel: Kernel }): Hono {
  const { kernel } = deps;
  const app = new Hono();

  /* ---------------------------------------------------------- /trigger */
  app.post('/trigger', async (c) => {
    const body = await safeJson<TriggerRequest>(c);
    const created = await kernel.trigger({
      taskId: body.taskId,
      payload: body.payload,
      options: body.options,
      // The run's isolation scope comes from the request body's options
      // (projectId/env), defaulting to default/prod. An invalid pair is
      // assertNamespace's KernelError('bad_request') → 400.
      namespace: namespaceFromOptions(body.options),
    });
    const res: TriggerResponse = { runId: created.runId, idempotent: created.idempotent };
    return c.json(res);
  });

  /* ---------------------------------------------------- /batch-trigger */
  app.post('/batch-trigger', async (c) => {
    const body = await safeJson<BatchTriggerRequest>(c);
    // The whole batch shares one namespace: per-item env/projectId are data,
    // the pair above them (body.options) is the scope.
    const { runIds } = await kernel.batchTrigger(body.items, namespaceFromOptions(body.options));
    const res: BatchTriggerResponse = { runIds };
    return c.json(res);
  });

  return app;
}
