/* =============================================================================
   @better-trigger/server — trigger API (app code / dashboard).
   POST /trigger · POST /batch-trigger
   See docs/backend-contract.md §4.
   ============================================================================= */
import { Hono } from 'hono';
import type {
  BatchTriggerRequest,
  BatchTriggerResponse,
  TriggerRequest,
  TriggerResponse,
} from '@better-trigger/core';
import { createRun, HttpError, withTx } from '../engine/runs';
import { assertArray, assertString } from '../validate';

export function triggerRoutes(): Hono {
  const app = new Hono();

  /* ---------------------------------------------------------- /trigger */
  app.post('/trigger', async (c) => {
    const body = await c.req.json<TriggerRequest>();
    assertString(body.taskId, 'taskId');
    const created = await createRun({
      taskId: body.taskId,
      payload: body.payload,
      options: body.options,
      triggerType: 'api',
      requireTask: true,
    });
    const res: TriggerResponse = { runId: created.runId, idempotent: created.idempotent };
    return c.json(res);
  });

  /* ---------------------------------------------------- /batch-trigger */
  app.post('/batch-trigger', async (c) => {
    const body = await c.req.json<BatchTriggerRequest>();
    assertArray(body.items, 'items');
    for (const item of body.items) {
      assertString((item as { taskId?: unknown })?.taskId, 'item.taskId');
    }
    const runIds = await withTx(async (client) => {
      const ids: string[] = [];
      for (const item of body.items) {
        const created = await createRun({
          taskId: item.taskId,
          payload: item.payload,
          options: item.options,
          triggerType: 'api',
          requireTask: true,
          client,
        });
        ids.push(created.runId);
      }
      return ids;
    });
    const res: BatchTriggerResponse = { runIds };
    return c.json(res);
  });

  return app;
}

export { HttpError };
