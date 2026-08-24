/* =============================================================================
   Better Trigger — one Idempotency-Key per retry INTENT (p2-38 repair).

   A retry key must live for a whole intent, not for one click event: the
   second half of a double-click (or any re-send racing the pending disabled
   state) has to carry the SAME key so the server's run_retry_operations
   replay path answers with the one run this intent already created instead of
   minting one run per delivery. This holder is what RunHeader keeps for its
   mounted lifetime: current() mints lazily on first use and returns the same
   key until clear() ends the intent (called from the request's finally —
   settle, success or failure, response arrived or not). The next current()
   is then a new intent with a fresh key.

   It is a synchronous closure, not useState: a second click can arrive in the
   same tick as the first, before any re-render could commit state, so the
   reuse decision must be readable without a render cycle. Each mounted
   RunHeader owns one holder — two dashboard tabs/replicas deliberately hold
   independent keys; cross-client dedup needs server-side coordination and is
   outside this protocol (docs/backend-contract.md §3.7).
   ============================================================================= */

export interface RetryIntentKey {
  /** The current intent's key. Mints one on first call; returns the SAME key
   *  on every later call until clear() ends the intent. */
  current(): string;
  /** End the intent — the next current() call mints a fresh key. */
  clear(): void;
}

export function createRetryIntentKey(): RetryIntentKey {
  let key: string | null = null;
  return {
    current() {
      if (key === null) {
        // Fallback for non-secure contexts where crypto.randomUUID is absent.
        key =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      return key;
    },
    clear() {
      key = null;
    },
  };
}
