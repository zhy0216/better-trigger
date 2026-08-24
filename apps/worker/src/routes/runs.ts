/* =============================================================================
   @better-trigger/worker — run control + read routes.
   POST /runs/:id/cancel · POST /runs/:id/retry
   GET  /runs/:id/record · GET  /runs/:id/result
   These are the endpoints the SDK client drives; the dashboard's richer
   /runs/:id detail view lives in routes/dashboard.ts.
   ============================================================================= */
import { Hono } from 'hono';
import { KernelError, type Kernel } from '@better-trigger/kernel';
import type { OkResponse, RetryRunResponse } from '../types';
import { ResultWaitAbortedError, type WaiterRegistry } from '../waiters';
import { namespaceFromQuery } from '../namespace';
import { intQuery } from '../http';

/** Upper bound on a single long-poll, so a request cannot outlive a proxy. */
const MAX_RESULT_WAIT_MS = 30_000;

export function runRoutes(deps: { kernel: Kernel; waiters?: WaiterRegistry }): Hono {
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
    // Request-level idempotency (p2-38): the Idempotency-Key header scopes the
    // operation to (project_id, env, source_run_id, operation_key) — repeated
    // sends of the same intent under the same key return the FIRST call's new
    // run id instead of creating one run per delivery. Absent (or blank) →
    // legacy semantics: every call is a fresh retry, nothing recorded.
    const rawKey = c.req.header('Idempotency-Key');
    // p2-38 repair: the header is validated, not trusted. A whitespace-only
    // key counts as no key (legacy semantics). An over-long key is refused
    // with a clean 400 instead of being written: keys are client-minted
    // opaque tokens (a UUID is 36 chars), so 200 chars is far past anything
    // legitimate while staying well under the btree index entry ceiling —
    // an unbounded key could otherwise blow the INSERT with pg's
    // "index row size exceeds maximum" and surface as a raw 500.
    const operationKey = rawKey?.trim();
    if (operationKey && operationKey.length > 200) {
      throw new KernelError('bad_request', 'Idempotency-Key must be at most 200 characters');
    }
    const { runId } = await kernel.retryRun(id, namespaceFromQuery(c), {
      operationKey: operationKey || undefined,
    });
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
    // Tolerance params: `?timeoutMs=abc` or out-of-range is silently clamped,
    // not refused (the SDK always sends well-formed values; a proxy mangling
    // them should not turn a wait into a 400). The choice is explicit here via
    // onInvalid:'clamp' — the API's OTHER numeric params refuse garbage (p2-32).
    const timeoutMs = intQuery(c, 'timeoutMs', { min: 0, max: MAX_RESULT_WAIT_MS, fallback: 5_000 }, { onInvalid: 'clamp' });
    const pollMs = intQuery(c, 'pollMs', { min: 50, max: 5_000, fallback: 250 }, { onInvalid: 'clamp' });
    const namespace = namespaceFromQuery(c);
    const opts = { timeoutMs, pollMs };
    // PF2: with an in-process waiter registry, N concurrent waiters share one
    // 1s sweep (plus terminal notifications) instead of N independent 4-QPS
    // poll loops. The kernel poll stays as the fallback for embedded hosts
    // that do not own a registry.
    if (!deps.waiters) {
      const result = await kernel.waitForResult(id, namespace, opts);
      return c.json(result);
    }
    // p1-14: the registry is told about the request's abort signal so a client
    // that disconnects mid-poll frees its waiter immediately instead of
    // hanging to the deadline on a dead socket. There is nothing to deliver to
    // a gone client, so an abort answers 499 (Client Closed Request) rather
    // than surfacing as a 500.
    try {
      const result = await deps.waiters.register(id, namespace, opts, c.req.raw.signal);
      return c.json(result);
    } catch (err) {
      if (err instanceof ResultWaitAbortedError) return new Response(null, { status: 499 });
      throw err;
    }
  });

  return app;
}
