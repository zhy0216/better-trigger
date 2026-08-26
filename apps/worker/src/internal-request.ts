/* =============================================================================
   @better-trigger/worker — internal-request marker.

   The embedded runtime (embedded.ts) dispatches its BetterTrigger client to
   the same Hono app a daemon would expose, but through an in-process fetch
   adapter — no socket, no hostile peer. The rate limiter exists to protect
   the *network-exposed* surface; the client's own calls must not draw from
   the anon bucket and 429 themselves under throughput. The embedded app can,
   however, also be mounted by the host as an external HTTP service, so the
   limiter must NOT be switched off app-wide: only the in-process path is
   trusted.

   A module-private `WeakSet<Request>` carries that trust. Only code in THIS
   process can write into it, and only the exact `Request` instance the
   embedded adapter constructs is ever marked — an external network request's
   `Request` can never be in the set, so the marker cannot be forged the way a
   request header (copied by any external client) could be. The limiter checks
   `isInternalRequest(c.req.raw)` — Hono preserves the original `Request`, so
   the marked instance is exactly what reaches the middleware.
   ============================================================================= */

const internalRequests = new WeakSet<Request>();

/** Mark a Request as a trusted, in-process dispatch (embedded fetch adapter). */
export function markInternalRequest(req: Request): void {
  internalRequests.add(req);
}

/** True only for Requests marked by this process's own code. */
export function isInternalRequest(req: Request): boolean {
  return internalRequests.has(req);
}