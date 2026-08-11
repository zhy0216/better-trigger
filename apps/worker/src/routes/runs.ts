/* =============================================================================
   @better-trigger/worker — run control + read routes.
   POST /runs/:id/cancel · POST /runs/:id/retry
   GET  /runs/:id/record · GET  /runs/:id/result
   These are the endpoints the SDK client drives; the dashboard's richer
   /runs/:id detail view lives in routes/dashboard.ts.
   ============================================================================= */
import { Hono } from 'hono';
import type { Kernel } from '@better-trigger/kernel';
import type { OkResponse, RetryRunResponse } from '../types';
import { namespaceFromQuery } from '../namespace';

/** Upper bound on a single long-poll, so a request cannot outlive a proxy. */
const MAX_RESULT_WAIT_MS = 30_000;

export function runRoutes(deps: { kernel: Kernel }): Hono {
  const { kernel } = deps;
  const app = new Hono();

  /* -------------------------------------------------------- cancel */
  app.post('/runs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    // Run ids are globally unique, but isolation is explicit: the caller says
    // which namespace it means (?projectId=&env=, default default/prod) and
    // the kernel predicates on the pair — a cancel can never reach a run in a
    // namespace the caller did not name (C2).
    await kernel.cancelRun(id, namespaceFromQuery(c));
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* --------------------------------------------------------- retry */
  app.post('/runs/:id/retry', async (c) => {
    const id = c.req.param('id');
    const { runId } = await kernel.retryRun(id, namespaceFromQuery(c));
    const res: RetryRunResponse = { runId };
    return c.json(res);
  });

  /* -------------------------------------------------------- record */
  // Light sibling of the dashboard's /runs/:id: the run row alone, no
  // steps/waits/logs — this is what SDK polling loops hit.
  app.get('/runs/:id/record', async (c) => {
    const run = await kernel.getRun(c.req.param('id'), namespaceFromQuery(c));
    return c.json(run);
  });

  /* -------------------------------------------------------- result */
  // Long-poll to a terminal state. Returns the latest non-terminal status once
  // the wait budget runs out; the client loops until ITS own deadline.
  app.get('/runs/:id/result', async (c) => {
    const id = c.req.param('id');
    const timeoutMs = clampQuery(c.req.query('timeoutMs'), 0, MAX_RESULT_WAIT_MS, 5_000);
    const pollMs = clampQuery(c.req.query('pollMs'), 50, 5_000, 250);
    const result = await kernel.waitForResult(id, namespaceFromQuery(c), { timeoutMs, pollMs });
    return c.json(result);
  });

  return app;
}

/** Parse a numeric query param into [min, max], falling back on garbage. */
function clampQuery(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
