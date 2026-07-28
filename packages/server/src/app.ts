/* =============================================================================
   @better-trigger/server — Hono app assembly (dashboard API).
   createApp({ kernel, pool }) wires middleware + all /api/v1 routes and a
   uniform error handler (KernelError code → status; everything else → 500).
   See docs/backend-contract.md §4–5.
   ============================================================================= */
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { KernelError, type Kernel, type KernelErrorCode } from '@better-trigger/core';
import type { ApiErrorBody } from './types';
import { authMiddleware, corsMiddleware } from './middleware';
import { triggerRoutes } from './routes/trigger';
import { runRoutes } from './routes/runs';
import { dashboardRoutes } from './routes/dashboard';

export interface AppDeps {
  /** The kernel backing trigger/cancel/retry (owned by the caller). */
  kernel: Kernel;
  /** The pg Pool for dashboard read queries (owned by the caller). */
  pool: Pool;
}

/** HTTP status per kernel error code; anything unknown falls through to 500. */
const STATUS_BY_CODE: Partial<Record<KernelErrorCode, 400 | 404 | 409>> = {
  bad_request: 400,
  not_found: 404,
  task_not_found: 404,
  run_not_running: 409,
  stale_lease: 409,
  conflict: 409,
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use('*', corsMiddleware);
  app.use('/api/v1/*', authMiddleware());

  const v1 = new Hono();
  v1.route('/', triggerRoutes(deps));
  v1.route('/', runRoutes(deps));
  v1.route('/', dashboardRoutes(deps));

  app.route('/api/v1', v1);

  // Uniform error handler.
  app.onError((err, c) => {
    if (err instanceof KernelError) {
      const status = STATUS_BY_CODE[err.code];
      if (status) {
        const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
        return c.json(body, status);
      }
    }
    console.error('[server] unhandled error:', err);
    const body: ApiErrorBody = {
      error: { code: 'internal_error', message: err.message || 'internal error' },
    };
    return c.json(body, 500);
  });

  app.notFound((c) => {
    const body: ApiErrorBody = { error: { code: 'not_found', message: 'route not found' } };
    return c.json(body, 404);
  });

  return app;
}
