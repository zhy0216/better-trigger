/* =============================================================================
   @better-trigger/worker — in-process result-waiter registry (PF2,
   todos/02-performance.md).

   The old path: every `GET /runs/:id/result` (and every in-process
   `RunHandle.result()`) ran its own kernel.waitForResult poll — N waiters ×
   ~4 SELECT/s against the runs table. This registry replaces that with one
   shared structure per process:

     - register(runId, ns, opts) does ONE initial DB read (so a run that is
       already terminal — or already gone — resolves instantly, with no race
       against a notification that was delivered before the waiter existed),
       then parks the waiter on a Map<runId, Set<entry>>;
     - a single shared poller (1s, unref'd) sweeps ALL pending waiters with one
       `WHERE id = ANY(...)` query and settles terminal/vanished/expired ones.
       This is the polling fallback — it keeps every waiter correct when the
       LISTEN connection is down or a notification is lost, at ~1 QPS per
       process instead of 4 QPS per waiter;
     - resolve(runId) — called by the notification dispatch when a `terminal`
       notification arrives — re-reads the run and settles every waiter for
       that runId at once.

   Semantics match kernel.waitForResult exactly: terminal returns
   { status, output, error }; timeout returns the latest non-terminal
   { status }; a vanished run rejects not_found. Notifications only make
   terminal resolution faster — never different.
   ============================================================================= */
import type { Pool } from 'pg';
import {
  KernelError,
  type Namespace,
  type RunStatus,
  type SerializedError,
  type WaitForResultOptions,
  type WaitResult,
} from '@better-trigger/core';
import { ResultTimeoutError } from 'better-trigger';
import type { NotifyCounters } from './observability';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'canceled']);

/** Monotonically increasing waiter id (p1-14): lets the registry name a
 *  specific entry, so an abort can target exactly the waiter it was handed. */
let nextWaiterId = 0;

interface PendingWaiter {
  id: number;
  runId: string;
  namespace: Namespace;
  resolve: (r: WaitResult) => void;
  reject: (err: unknown) => void;
  deadline: number;
  lastStatus: RunStatus;
  /** The caller's timeout budget, for the ResultTimeoutError message (p2-23). */
  timeoutMs: number;
  /** throwOnTimeout (p2-23): a timeout rejects with ResultTimeoutError instead
   *  of resolving the latest non-terminal status. */
  throwOnTimeout: boolean;
}

interface RunRead {
  status: RunStatus;
  output: unknown;
  error: unknown;
}

/**
 * Rejected to every still-pending waiter when the registry stops (daemon
 * shutdown). Deliberately NOT a terminal status: this process cannot know the
 * run's outcome from here, and a fabricated `{ status }` would be a lie the
 * caller could mistake for the engine's verdict. The route maps it to a 5xx
 * the SDK can retry against another daemon.
 */
export class WaiterRegistryStoppedError extends Error {
  constructor() {
    super('daemon shutting down: result waiter abandoned');
    this.name = 'WaiterRegistryStoppedError';
  }
}

/**
 * Rejected to a /result waiter whose client disconnected before the run
 * reached a terminal state. `name` is 'AbortError' (the DOM convention) so
 * the HTTP route can recognise it and answer 499 — Client Closed Request —
 * instead of surfacing as a 500: the client is gone, the only point is
 * freeing the waiter and its socket, not delivering a body.
 */
export class ResultWaitAbortedError extends Error {
  constructor() {
    super('result wait aborted by the client');
    this.name = 'AbortError';
  }
}

export interface WaiterRegistry {
  /** Wait for a terminal state (timeout → latest non-terminal status). A
   *  caller that can observe client disconnects passes `signal`; when it
   *  aborts while the waiter is still pending, the entry is removed at once
   *  and the promise rejects with ResultWaitAbortedError (name 'AbortError')
   *  instead of hanging to the deadline on a dead socket. */
  register(
    runId: string,
    namespace: Namespace,
    opts?: WaitForResultOptions,
    signal?: AbortSignal,
  ): Promise<WaitResult>;
  /** A `terminal` notification arrived for this runId (namespace already
   *  matched by the dispatch). Settles every waiter for it. */
  resolve(runId: string): Promise<void>;
  /** Number of waiters still pending (observability probe). */
  pending(): number;
  stop(): void;
}

export function createWaiterRegistry(deps: {
  pool: Pool;
  counters: NotifyCounters;
  /** Test knob: the shared poller interval (default 1s). */
  pollMs?: number;
}): WaiterRegistry {
  const { pool, counters } = deps;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const pending = new Map<string, Set<PendingWaiter>>();
  let stopped = false;

  function remove(entry: PendingWaiter): void {
    const set = pending.get(entry.runId);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) pending.delete(entry.runId);
  }

  function isPending(entry: PendingWaiter): boolean {
    return pending.get(entry.runId)?.has(entry) ?? false;
  }

  function toResult(row: RunRead): WaitResult {
    return {
      status: row.status,
      output: row.output ?? undefined,
      error: (row.error as SerializedError | null) ?? undefined,
    };
  }

  async function readRun(runId: string, namespace: Namespace): Promise<RunRead | null> {
    const res = await pool.query<{ status: string; output: unknown; error: unknown }>(
      `SELECT status, output, error FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`,
      [runId, namespace.projectId, namespace.env],
    );
    const row = res.rows[0];
    return row ? { status: row.status as RunStatus, output: row.output, error: row.error } : null;
  }

  function settle(entry: PendingWaiter, row: RunRead): void {
    remove(entry);
    counters.waiterResolutions += 1;
    entry.resolve(toResult(row));
  }

  function settleGone(entry: PendingWaiter): void {
    remove(entry);
    counters.waiterResolutions += 1;
    entry.reject(new KernelError('not_found', `run ${entry.runId} not found`));
  }

  function settleTimeout(entry: PendingWaiter): void {
    remove(entry);
    counters.waiterTimeouts += 1;
    // Latest non-terminal status — the exact waitForResult timeout semantics.
    // Unless the caller asked for the timeout to throw (p2-23): then reject
    // with ResultTimeoutError so an in-run handle.result({throwOnTimeout})
    // behaves the same as the HTTP long-poll path.
    if (entry.throwOnTimeout) {
      entry.reject(new ResultTimeoutError(entry.runId, entry.timeoutMs, entry.lastStatus));
      return;
    }
    entry.resolve({ status: entry.lastStatus });
  }

  async function register(
    runId: string,
    namespace: Namespace,
    opts: WaitForResultOptions = {},
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    if (stopped) throw new WaiterRegistryStoppedError(); // defensive: the server is closed first
    // An already-disconnected client: settle immediately, and do not even
    // spend the initial read on a request nobody will see the answer to.
    if (signal?.aborted) throw new ResultWaitAbortedError();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // One read up front: the run may already be terminal (or already gone).
    // This is also the race guard — a notification delivered between the
    // caller's check and this registration cannot be missed because the read
    // below sees the terminal state directly.
    const row = await readRun(runId, namespace);
    if (!row) throw new KernelError('not_found', `run ${runId} not found`);
    if (TERMINAL.has(row.status)) return toResult(row);
    if (timeoutMs <= 0) return { status: row.status };

    return new Promise<WaitResult>((resolve, reject) => {
      const entry: PendingWaiter = {
        id: nextWaiterId++,
        runId,
        namespace,
        resolve,
        reject,
        deadline: Date.now() + timeoutMs,
        lastStatus: row.status,
        timeoutMs,
        throwOnTimeout: opts.throwOnTimeout ?? false,
      };
      const onAbort = () => {
        // Only an entry that is still pending may be settled here; a waiter
        // the sweep or a notification already resolved must not be disturbed
        // (its client got an answer, and the promise settles once).
        if (!isPending(entry)) return;
        remove(entry);
        reject(new ResultWaitAbortedError());
      };
      // The aborted check is re-done in the executor: the pre-read guard above
      // and this one bracket the async read, so an abort that lands while the
      // read was in flight still frees the entry instead of registering it.
      // The addEventListener is safe here — abort events are dispatched on the
      // task queue, never synchronously, so a signal that reads `aborted ===
      // false` now will deliver its abort to the listener.
      if (signal?.aborted) {
        reject(new ResultWaitAbortedError());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      let set = pending.get(runId);
      if (!set) {
        set = new Set();
        pending.set(runId, set);
      }
      set.add(entry);
    });
  }

  async function resolve(runId: string): Promise<void> {
    const set = pending.get(runId);
    if (!set || set.size === 0) return;
    // A run lives in exactly one namespace, so every waiter of one runId
    // shares it in practice; read with the first entry's.
    const namespace = [...set][0]!.namespace;
    let row: RunRead | null;
    try {
      row = await readRun(runId, namespace);
    } catch {
      return; // DB hiccup — the shared poller retries
    }
    const entries = [...set];
    if (!row) {
      // Run vanished (pruned): fail the waiters like waitForResult would.
      for (const e of entries) {
        if (isPending(e)) settleGone(e);
      }
      return;
    }
    if (!TERMINAL.has(row.status)) return; // stale notification — the poller owns it
    for (const e of entries) {
      if (isPending(e)) settle(e, row);
    }
  }

  async function sweep(): Promise<void> {
    if (stopped) return;
    const entries: PendingWaiter[] = [];
    for (const set of pending.values()) for (const e of set) entries.push(e);
    if (entries.length === 0) return;

    const ids = [...new Set(entries.map((e) => e.runId))];
    let rows: Array<{ id: string; status: string; output: unknown; error: unknown }>;
    try {
      const res = await pool.query<{ id: string; status: string; output: unknown; error: unknown }>(
        `SELECT id, status, output, error FROM runs WHERE id = ANY($1::text[])`,
        [ids],
      );
      rows = res.rows;
    } catch {
      return; // DB hiccup — next sweep
    }
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Namespace note: the batch read keys on run id alone — no project/env
    // predicate. That is deliberate: run ids are globally unique (C2 keeps
    // the namespace as a scoping predicate, not a key component), and every
    // waiter registered with a namespace the initial read already validated.
    // A per-waiter namespace filter here would only re-derive the same rows.
    for (const e of entries) {
      if (!isPending(e)) continue; // a notification already settled it
      const row = byId.get(e.runId);
      if (!row) {
        settleGone(e);
        continue;
      }
      e.lastStatus = row.status as RunStatus;
      if (TERMINAL.has(row.status as RunStatus)) {
        settle(e, { status: row.status as RunStatus, output: row.output, error: row.error });
        continue;
      }
      if (e.deadline <= Date.now()) settleTimeout(e);
    }
  }

  // p2-18 C4: re-entrancy guard, same single-flight shape as the orchestrator
  // loops' running flags. isPending already prevented double-settling, but a
  // sweep still slower than pollMs (a degraded database) would otherwise keep
  // launching overlapping batch reads that all re-query the same waiters.
  let sweeping = false;
  const pollTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweep().finally(() => {
      sweeping = false;
    });
  }, pollMs);
  (pollTimer as { unref?: () => void }).unref?.();

  return {
    register,
    resolve,
    pending() {
      let n = 0;
      for (const set of pending.values()) n += set.size;
      return n;
    },
    stop() {
      stopped = true;
      clearInterval(pollTimer);
      // The daemon is exiting: no sweep will ever run again, so every
      // still-pending waiter must be settled NOW or its promise hangs forever
      // (and its 1s poll timer would keep querying a pool that is about to
      // close). Reject — never resolve a fabricated status (see
      // WaiterRegistryStoppedError). A sweep already in flight cannot double-
      // settle: it re-checks isPending, and stop() already removed everyone.
      const err = new WaiterRegistryStoppedError();
      for (const set of pending.values()) {
        for (const e of [...set]) {
          remove(e);
          e.reject(err);
        }
      }
    },
  };
}
