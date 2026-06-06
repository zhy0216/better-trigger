/* =============================================================================
   @better-trigger/server — middleware.
   Bearer auth (skipped when BETTER_TRIGGER_API_KEY is unset; /health always
   open) + permissive CORS for local tooling.
   ============================================================================= */
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

export const corsMiddleware: MiddlewareHandler = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
});

/** Bearer auth. No-op when the env key is unset. /api/v1/health is always open. */
export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const apiKey = process.env.BETTER_TRIGGER_API_KEY;
    if (!apiKey) return next();

    const path = c.req.path;
    if (path === '/api/v1/health') return next();

    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== apiKey) {
      return c.json(
        { error: { code: 'unauthorized', message: 'invalid or missing API key' } },
        401,
      );
    }
    return next();
  };
}
