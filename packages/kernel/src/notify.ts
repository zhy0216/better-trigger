/* =============================================================================
   @better-trigger/kernel — notification fast-path (PF2, todos/02-performance.md).

   Every daemon LISTENs on a single channel; the kernel write paths say "new
   work appeared" or "a run went terminal" by running `SELECT pg_notify(...)`
   as the LAST statement inside their transaction. NOTIFY is delivered only at
   COMMIT, so the notification carries exactly the transaction's outcome:
   a rolled-back tx sends nothing, a committed one sends what it did.

   Two payload shapes, deliberately minimal (PF2 §4 — ids/namespace only,
   never business payload):

     - { type: 'work' }            — something became claimable. Three sources:
       (1) a fresh enqueue (trigger / batch / retry / child fan-out / cron),
       (2) a waiting run re-enqueued by its wait resolving (orchestrator
       resume, parent wakeup), and (3) a concurrency slot released by a
       run that stopped counting as 'running' — the terminal paths
       (complete/fail/cancel of a concurrency-keyed run) and the
       non-immediate suspend path (p2-41). No run id on purpose: the
       receiver's job is just "go claim", and the claim scan's SKIP LOCKED
       is namespace-safe by itself, so there is nothing to filter.
       Aggregate-safe too: a 500-item batch sends one notification, which is
       also what keeps the payload far under pg's 8000-byte NOTIFY cap.

     - { type: 'terminal', runId, projectId, env } — a run reached a terminal
       state. Waiters match on runId; listeners filter on the namespace pair.

   A slot release MUST notify exactly like an enqueue does: the claim loop a
   queued run is waiting on parks in its idle backoff, and it only wakes
   early when the `work` notification resolves the sleep. Skip it and the
   released slot stays invisible until the next poll.

   Notifications are a latency optimization ONLY. Every consumer keeps its
   polling fallback (claim idle backoff, the wait-due scan, the waiter
   registry's shared 1s sweep), so a lost/dropped notification costs at most
   the next poll interval and never a correctness failure.

   Sending is SQL-level and stays inside the tx, so no withTx change and no
   post-commit hook is needed — and it covers the inline BEGIN/COMMIT paths
   (scanCron, reap, releaseClaims) as well as withTx.
   ============================================================================= */
import type { PoolClient } from 'pg';
import type { Namespace } from '@better-trigger/core';

/** The single channel every daemon LISTENs on (PF2 §channel). */
export const NOTIFY_CHANNEL = 'bt';

/** `work` payload — a bare marker, no run id (see file header). */
const WORK_PAYLOAD = JSON.stringify({ type: 'work' });

/**
 * Send the `work` notification on the caller's transaction connection. Must be
 * the last statement of the tx: it only lands when the tx commits.
 */
export function notifyWork(client: PoolClient): Promise<unknown> {
  return client.query(`SELECT pg_notify($1, $2)`, [NOTIFY_CHANNEL, WORK_PAYLOAD]);
}

/**
 * Send the `terminal` notification for `runId` on the caller's transaction
 * connection (last statement of the tx — delivered at COMMIT). The namespace
 * rides along so listeners can drop notifications for scopes they do not
 * serve (PF2 §cross-daemon).
 */
export function notifyTerminal(
  client: PoolClient,
  runId: string,
  namespace: Namespace,
): Promise<unknown> {
  return client.query(`SELECT pg_notify($1, $2)`, [
    NOTIFY_CHANNEL,
    JSON.stringify({
      type: 'terminal',
      runId,
      projectId: namespace.projectId,
      env: namespace.env,
    }),
  ]);
}
