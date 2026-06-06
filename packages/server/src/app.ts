/* =============================================================================
   @better-trigger/server — Hono app assembly.
   createApp(deps?) wires middleware + all /api/v1 routes and a uniform error
   handler (HttpError → its status/code; everything else → 500).
   See docs/backend-contract.md §4–5.
   ============================================================================= */
import { Hono } from 'hono';
import type { ApiErrorBody } from '@better-trigger/core';
import { authMiddleware, corsMiddleware } from './middleware';
import { HttpError } from './engine/runs';
import { workerRoutes } from './routes/workers';
import { triggerRoutes } from './routes/trigger';
import { runRoutes } from './routes/runs';
import { dashboardRoutes } from './routes/dashboard';

export interface AppDeps {
  /** Reserved for tests/DI; routes currently read the shared pool directly. */
  version?: string;
}

export function createApp(_deps: AppDeps = {}): Hono {
  const app = new Hono();

  app.use('*', corsMiddleware);
  app.use('/api/v1/*', authMiddleware());

  const v1 = new Hono();
  v1.route('/', workerRoutes());
  v1.route('/', triggerRoutes());
  v1.route('/', runRoutes());
  v1.route('/', dashboardRoutes());

  app.route('/api/v1', v1);

  // Uniform error handler.
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
      return c.json(body, err.status as 400 | 404 | 409);
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
