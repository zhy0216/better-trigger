/* =============================================================================
   @better-trigger/worker — request audit log (O6, todos/03-operability.md).

   One middleware, wrapped around the whole /api/v1 surface (auth, rate
   limit, body limit, routes), records one structured JSON line per request:

     [audit] {"audit":true,"ts":...,"requestId":"req_...","method":"POST",
              "path":"/api/v1/trigger","endpoint":"trigger","key":"key_ab12cd34…",
              "caller":"127.0.0.1","taskIds":["send-email"],"runIds":["run_..."],
              "status":200,"result":"accepted","reason":null}

   - `requestId` is a fresh correlation id per request, echoed as the
     x-request-id response header and reused by the production 500 body (the
     same id appears in the audit line, the header and the onError log line).
   - `key` is a sha256 fingerprint, never the secret itself.
   - `caller` is the TCP peer address; 'unknown' for in-process requests.
     X-Forwarded-For is NOT trusted: it is spoofable, and behind a reverse
     proxy the socket is the proxy's anyway (see README "Network exposure").
   - `taskIds` come from the request body (trigger / batch-trigger only),
     `runIds` from the response body or the path, `scheduleIds` from the
     path (PATCH /schedules/:id). Neither ever contains the
     payload: the payload is the one thing an audit line must not carry, so
     it is never read (the request body is read via a pre-next clone — the
     tee branch stays readable after the route consumed the stream — and the
     response body is read only on the four write endpoints, whose bodies
     are tiny id lists).
   - `reason` is the error code on ANY rejection (unauthorized, key_expired,
     rate_limited, bad_request, not_found, internal_error, …) — rejected
     requests are audited too, with the reason.
   - `result` is 'accepted' (2xx/3xx) or 'rejected' (4xx/5xx).

   Exempt: OPTIONS preflights (browser noise) and /health (unauthenticated
   by design and polled by every load balancer / container healthcheck).

   Rejections that flow through app.onError (thrown KernelErrors) are still
   recorded: Hono converts the throw into a response before the middleware
   chain unwinds, so after `await next()` c.res is the final response —
   error envelope and all — and the middleware never has to re-derive it.

   The log is deliberately NOT a database table: an audit table would grow
   without bound on the same Postgres that stores runs, and every row would
   be one more write on the critical path. Structured stdout lines are
   greppable (`grep '\[audit\]'`), pipeable to jq, and shipable to any log
   collector. Retention of the lines is the collector's job, not the
   daemon's.
   ============================================================================= */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { remoteAddressOf, type AppVariables } from './middleware';
import { endpointOf, type RateLimitedEndpoint } from './rate-limit';
/** Cap on task/run ids recorded in one audit line — enough to correlate, not
 *  enough to bloat the log with a 500-item batch's full id list. */
const IDS_CAP = 10;

export interface AuditEntry {
  audit: true;
  /** ISO-8601 instant the request finished. */
  ts: string;
  /** Correlation id; echoed as the x-request-id header and on a production
   *  500 body. */
  requestId: string;
  method: string;
  path: string;
  /** One of the run-affecting write endpoints, or null for reads/dashboard. */
  endpoint: RateLimitedEndpoint | null;
  /** sha256 fingerprint of the API key that authenticated the request, or
   *  null when no key is configured. */
  key: string | null;
  /** TCP peer address; 'unknown' when there is no socket (in-process
   *  requests). Behind a reverse proxy this is the proxy's address. */
  caller: string;
  /** Task ids from the request body, deduped and capped; null when the body
   *  was not read (rejected request, or a non-trigger endpoint). */
  taskIds: string[] | null;
  /** Run ids this request acted on (cancel/retry path) or created
   *  (response body), capped. */
  runIds: string[] | null;
  /** Schedule id this request acted on (PATCH /schedules/:id path). */
  scheduleIds: string[] | null;
  status: number;
  result: 'accepted' | 'rejected';
  /** Error code from the response envelope on a rejection, else null. */
  reason: string | null;
}

export function auditMiddleware(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    // Exempt: OPTIONS preflights and /health (see the file header).
    if (c.req.method === 'OPTIONS' || c.req.path === '/api/v1/health') return next();
    const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    c.set('auditRequestId', requestId);
    // Clone before next(): the route (and the body-limit middleware) consume
    // the request stream, after which the original is disturbed and cannot be
    // cloned. The clone's tee branch stays readable later. Reading it happens
    // only for accepted requests — a rejected body was never checked against
    // the body cap by anyone downstream, so it must not be parsed here either.
    const bodyClone =
      c.req.method === 'POST' &&
      (c.req.path === '/api/v1/trigger' || c.req.path === '/api/v1/batch-trigger')
        ? c.req.raw.clone()
        : null;
    await next();
    const entry = await buildEntry(c, requestId, bodyClone);
    // The correlation id travels with the response too: a client that logs
    // the header can hand it to an operator, who greps the audit line.
    c.res.headers.set('x-request-id', requestId);
    console.log(`[audit] ${JSON.stringify(entry)}`);
  };
}

async function buildEntry(
  c: Context<{ Variables: AppVariables }>,
  requestId: string,
  bodyClone: Request | null,
): Promise<AuditEntry> {
  const method = c.req.method;
  const path = c.req.path;
  // endpointOf also classifies reads as 'read' (so the rate limiter can bucket
  // them); the audit line's endpoint field keeps meaning "the run-affecting
  // write endpoint" — reads stay null, and nothing on a read is parsed for
  // task/run ids (that parsing is for the write endpoints' id lists).
  const classified = endpointOf(method, path);
  const endpoint: RateLimitedEndpoint | null = classified === 'read' ? null : classified;
  const status = c.res.status;
  const accepted = status < 400;
  let reason: string | null = null;
  let taskIds: string[] | null = null;
  let runIds: string[] | null = null;
  let scheduleIds: string[] | null = null;
  if (accepted) {
    if (endpoint !== null) {
      taskIds = await taskIdsFromBody(c, endpoint, bodyClone);
      runIds = await runIdsFromResponse(c, endpoint);
      scheduleIds = scheduleIdsFromPath(endpoint, path);
    }
  } else {
    // Every rejection carries its reason, whatever endpoint was asked for:
    // the error code in the response envelope (unauthorized, key_expired,
    // rate_limited, bad_request, not_found, internal_error, …).
    reason = await errorCodeOf(c.res);
  }
  return {
    audit: true,
    ts: new Date().toISOString(),
    requestId,
    method,
    path,
    endpoint,
    key: c.get('authKeyId') ?? null,
    caller: remoteAddressOf(c) ?? 'unknown',
    taskIds,
    runIds,
    scheduleIds,
    status,
    result: accepted ? 'accepted' : 'rejected',
    reason,
  };
}

/** The task ids a trigger/batch-trigger request names, from the cloned body. */
async function taskIdsFromBody(
  _c: Context<{ Variables: AppVariables }>,
  endpoint: RateLimitedEndpoint,
  bodyClone: Request | null,
): Promise<string[] | null> {
  if (endpoint !== 'trigger' && endpoint !== 'batch-trigger') return null;
  if (bodyClone === null) return null;
  let body: unknown;
  try {
    body = await bodyClone.json();
  } catch {
    return null; // malformed body — the route already answered 400
  }
  const obj = body as { taskId?: unknown; items?: unknown };
  if (endpoint === 'trigger') {
    return typeof obj.taskId === 'string' ? [obj.taskId] : null;
  }
  if (!Array.isArray(obj.items)) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of obj.items) {
    const taskId = (item as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId !== 'string' || seen.has(taskId)) continue;
    seen.add(taskId);
    ids.push(taskId);
    if (ids.length >= IDS_CAP) break;
  }
  return ids.length > 0 ? ids : null;
}

/** The run ids a request acted on (cancel/retry path) or created (response). */
async function runIdsFromResponse(
  c: Context<{ Variables: AppVariables }>,
  endpoint: RateLimitedEndpoint,
): Promise<string[] | null> {
  if (endpoint === 'cancel') {
    const id = runIdFromPath(c.req.path);
    return id !== null ? [id] : null;
  }
  // schedule ids live on the path, not in the response's id list.
  if (endpoint === 'schedule') return null;
  const resBody = await jsonBodyOf(c.res);
  if (resBody === null) return endpoint === 'retry' ? runIdFromPathList(c.req.path) : null;
  const obj = resBody as { runId?: unknown; runIds?: unknown };
  if (endpoint === 'trigger' || endpoint === 'retry') {
    if (typeof obj.runId !== 'string') {
      // retry still names the run it acted on even if the response is odd.
      return endpoint === 'retry' ? runIdFromPathList(c.req.path) : null;
    }
    if (endpoint === 'retry') {
      const acted = runIdFromPath(c.req.path);
      return acted !== null ? [acted, obj.runId] : [obj.runId];
    }
    return [obj.runId];
  }
  // batch-trigger
  if (!Array.isArray(obj.runIds)) return null;
  const ids = obj.runIds.filter((id): id is string => typeof id === 'string').slice(0, IDS_CAP);
  return ids.length > 0 ? ids : null;
}

function runIdFromPath(path: string): string | null {
  const match = /^\/api\/v1\/runs\/([^/]+)\/(cancel|retry)$/.exec(path);
  return match !== null ? match[1] : null;
}

function runIdFromPathList(path: string): string[] | null {
  const id = runIdFromPath(path);
  return id !== null ? [id] : null;
}

/** The schedule id a PATCH /schedules/:id request acted on. */
function scheduleIdsFromPath(endpoint: RateLimitedEndpoint, path: string): string[] | null {
  if (endpoint !== 'schedule') return null;
  const match = /^\/api\/v1\/schedules\/([^/]+)$/.exec(path);
  return match !== null ? [match[1]] : null;
}

/** The error code from a rejection envelope, or null if it is not JSON. */
async function errorCodeOf(res: Response): Promise<string | null> {
  const body = await jsonBodyOf(res);
  if (body === null) return null;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' ? code : null;
}

/** The response body as JSON, or null when unreadable (non-JSON, empty, …). */
async function jsonBodyOf(res: Response): Promise<unknown | null> {
  try {
    return await res.clone().json();
  } catch {
    return null;
  }
}
