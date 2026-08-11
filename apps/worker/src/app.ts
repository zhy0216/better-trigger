/* =============================================================================
   @better-trigger/worker — Hono app assembly (dashboard API).
   createApp({ kernel, pool }) wires middleware + all /api/v1 routes and a
   uniform error handler (KernelError code → status; everything else → 500).
   See docs/backend-contract.md §4–5.
   ============================================================================= */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';
import { KernelError, type Kernel, type KernelErrorCode } from '@better-trigger/kernel';
import type { ApiErrorBody } from './types';
import { authMiddleware, corsMiddleware } from './middleware';
import { triggerRoutes } from './routes/trigger';
import { runRoutes } from './routes/runs';
import { dashboardRoutes } from './routes/dashboard';
import { metricsRoutes, type MetricsSources } from './routes/metrics';
import type { WaiterRegistry } from './waiters';

export interface AppDeps {
  /** The kernel backing trigger/cancel/retry (owned by the caller). */
  kernel: Kernel;
  /** The pg Pool for dashboard read queries (owned by the caller). */
  pool: Pool;
  /**
   * PF4 (todos/02-performance.md): a small dedicated pool — createHealthPool()
   * — for the /health?deep=1 and /metrics probes. A probe that hangs (or a
   * scrape storm against a half-dead database) must never hold a business-pool
   * connection, and its statement_timeout is what actually cancels the probe
   * query server-side. The daemon (main.ts) always passes it. Tests and
   * embedded callers may omit it: the probes then share the business pool,
   * which is safe for a healthy database but means a hung database can hold
   * business connections through the probes — production deployments should
   * run through the daemon (which wires a real probe pool), or pass their own
   * createHealthPool() here.
   */
  probePool?: Pool;
  /** Live counters /metrics reads off the runtime and the orchestrator. Absent
   *  when the caller has neither (an embedded app, a test): the endpoint then
   *  reports the database gauges and zeros. */
  metrics?: MetricsSources;
  /**
   * PF2: the in-process result-waiter registry, when the caller owns one (the
   * daemon does). /result then waits through it — one shared 1s sweep plus
   * terminal notifications — instead of one kernel poll loop per request.
   */
  waiters?: WaiterRegistry;
  /** Namespaces this daemon serves — /metrics labels its queue/in-flight
   *  gauges per namespace with these. Absent → default/prod. */
  namespaces?: readonly Namespace[];
}

/** HTTP status per kernel error code; anything unknown falls through to 500. */
const STATUS_BY_CODE: Partial<Record<KernelErrorCode, 400 | 404 | 409 | 413>> = {
  bad_request: 400,
  serialization_error: 400,
  not_found: 404,
  task_not_found: 404,
  run_not_running: 409,
  stale_lease: 409,
  conflict: 409,
  // The body-limit middleware below answers 413 itself; this keeps the code
  // mapped to the same status should it ever arrive as a thrown KernelError.
  payload_too_large: 413,
};

/** Request body cap in bytes; 1 MiB unless BETTER_TRIGGER_BODY_LIMIT says else. */
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

function bodyLimitBytes(): number {
  const raw = process.env.BETTER_TRIGGER_BODY_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_BODY_LIMIT_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_BODY_LIMIT_BYTES;
}

/** Read per request, so a test (or a reload) can flip it without re-assembly. */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Short correlation id shared by the 500 body and its server log line. */
function requestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use('*', corsMiddleware);
  app.use('/api/v1/*', authMiddleware());

  // Refuse an oversized body before anything buffers it: `c.req.json()` would
  // otherwise read a 500MB POST straight into the daemon's heap. Content-Length
  // short-circuits; a chunked body is measured as it streams. Answered right
  // here (413 + the normal error envelope) rather than thrown, so it never
  // reaches onError as an HTTPException that would read as a 500.
  const maxBody = bodyLimitBytes();
  app.use(
    '/api/v1/*',
    bodyLimit({
      maxSize: maxBody,
      onError: (c) => {
        const body: ApiErrorBody = {
          error: {
            code: 'payload_too_large',
            message: `request body must be at most ${maxBody} bytes`,
          },
        };
        return c.json(body, 413);
      },
    }),
  );

  const v1 = new Hono();
  v1.route('/', triggerRoutes(deps));
  v1.route('/', runRoutes({ kernel: deps.kernel, waiters: deps.waiters }));
  v1.route('/', dashboardRoutes(deps));
  v1.route(
    '/',
    metricsRoutes({
      pool: deps.pool,
      probePool: deps.probePool,
      metrics: deps.metrics,
      namespaces: deps.namespaces,
    }),
  );

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
    // Anything else is a bug or an infrastructure failure, and its message is
    // whatever pg / the connection layer produced: table, column and constraint
    // names, sometimes a host or a connection-string fragment. Locally that
    // detail is exactly what you want; in production it hands out the schema,
    // so the caller gets a generic message plus a requestId and the real error
    // goes to the log under the same id. (KernelError above is untouched —
    // those messages are ours, written for the caller.)
    if (isProduction()) {
      const id = requestId();
      console.error(`[server] unhandled error (${id}):`, err);
      const body: ApiErrorBody = {
        error: { code: 'internal_error', message: 'internal error', requestId: id },
      };
      return c.json(body, 500);
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
