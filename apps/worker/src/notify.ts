/* =============================================================================
   @better-trigger/worker — the notification fast-path (PF2,
   todos/02-performance.md): the receiving side of the kernel's pg_notify.

   main.ts owns ONE dedicated LISTEN connection per daemon — a plain
   `new pg.Client`, deliberately NOT a pool checkout (a released pool client
   is idle-destroyed after 10s, which would silently kill the LISTEN). It
   receives on the single `bt` channel and dispatches:

     - { type: 'work' }      → wake every idle claim sleep (sleepWithWake);
     - { type: 'terminal' }   → resolve the run's result waiters (waiters.ts).

   The connection re-establishes itself with backoff on error/end and re-issues
   LISTEN (pg does not remember it across reconnects). While it is down —
   including when it never came up — every consumer keeps its polling fallback:
   notifications are a latency optimization, never a correctness source.

   This module also carries the claim-wake primitives (WakeSignal +
   sleepWithWake) so runtime.ts can race an idle backoff against a wake
   without knowing anything about Postgres.
   ============================================================================= */
import pg from 'pg';
import type { NotifyCounters, WorkerLogger } from './observability';

const { Client } = pg;

/** The single channel every daemon LISTENs on (kernel/src/notify.ts). */
export const NOTIFY_CHANNEL = 'bt';

/** Payloads the kernel sends inside its transactions (see kernel notify.ts). */
export type NotifyPayload =
  | { type: 'work' }
  | { type: 'terminal'; runId: string; projectId: string; env: string };

/** Sink for LISTEN lifecycle messages; structurally `console`. */
export interface NotifyLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

/* ---------------------------------------------------------------------------
 * Claim-wake primitives (runtime.ts consumes these)
 * ------------------------------------------------------------------------- */

/** A process-wide "something became claimable" signal. */
export interface WakeSignal {
  /** Resolve every currently-subscribed wake listener (an idle claim sleep). */
  emit(): void;
  /** Register a listener; returns an unregister fn. */
  subscribe(fn: () => void): () => void;
}

export function createWakeSignal(): WakeSignal {
  const listeners = new Set<() => void>();
  return {
    emit() {
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** Plain unref'd sleep, shared with the rest of the runtime. */
function plainSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * `sleep(ms)` that returns early when `wake` fires — the idle claim loop's
 * sleep raced against a `work` notification. Without a wake signal it is a
 * plain sleep (embedded hosts, tests).
 */
export function sleepWithWake(ms: number, wake: WakeSignal | null | undefined): Promise<void> {
  if (!wake) return plainSleep(ms);
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    timer = setTimeout(finish, ms);
    (timer as { unref?: () => void }).unref?.();
    unsubscribe = wake.subscribe(finish);
  });
}

/* ---------------------------------------------------------------------------
 * The LISTEN connection
 * ------------------------------------------------------------------------- */

export interface NotifyListener {
  /** Close the LISTEN connection and stop reconnecting (idempotent). */
  stop(): Promise<void>;
}

export interface NotifyListenerDeps {
  connectionString: string;
  logger: NotifyLogger;
  counters: NotifyCounters;
  onNotify: (payload: NotifyPayload) => void;
  /** Test knob: how the connection is created (defaults to a plain pg.Client
   *  on `connectionString`). */
  createClient?: () => pg.Client;
  /** Test knob: reconnect backoff base (default 1s, doubling to 30s). */
  reconnectBaseMs?: number;
}

/**
 * Open (or keep re-opening) the dedicated LISTEN connection and dispatch
 * parsed payloads to `onNotify`. Never throws: connect failures are logged and
 * retried with backoff while the daemon's polling keeps working.
 */
export function createNotifyListener(deps: NotifyListenerDeps): NotifyListener {
  const {
    connectionString,
    logger,
    counters,
    onNotify,
    createClient = () => new Client({ connectionString }),
    reconnectBaseMs = 1_000,
  } = deps;
  let client: pg.Client | null = null;
  let stopping = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectScheduled = false;
  let reconnectDelayMs = reconnectBaseMs;

  function scheduleReconnect(): void {
    // 'error' and the 'end' that usually follows both land here; without the
    // flag every broken connection would schedule two reconnects. One attempt
    // per broken connection is enough — connect() either succeeds or schedules
    // the next one.
    if (stopping || reconnectScheduled) return;
    reconnectScheduled = true;
    counters.listenReconnects += 1;
    reconnectTimer = setTimeout(() => {
      reconnectScheduled = false;
      void connect();
    }, reconnectDelayMs);
    (reconnectTimer as { unref?: () => void }).unref?.();
    reconnectDelayMs = Math.min(30_000, reconnectDelayMs * 2);
  }

  async function connect(): Promise<void> {
    if (stopping) return;
    const c = createClient();
    client = c;
    try {
      await c.connect();
      await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
      reconnectDelayMs = reconnectBaseMs; // a live connection resets the backoff
      logger.info?.('[better-trigger] notification fast-path: LISTEN bt connected');
    } catch (err) {
      // A client whose connect/LISTEN failed is broken and would leak its
      // socket if left around — close it (it has no listeners yet, so nothing
      // else will) before scheduling the retry.
      await c.end().catch(() => {});
      if (client === c) client = null;
      // DB unreachable at boot or mid-flight: degrade to polling. The channel
      // is an optimization, so this must never take the daemon down.
      logger.warn(
        `[better-trigger] notification fast-path: LISTEN failed ` +
          `(${err instanceof Error ? err.message : String(err)}); polling covers it — retrying in background`,
      );
      scheduleReconnect();
      return;
    }

    c.on('notification', (msg) => {
      counters.notificationsReceived += 1;
      if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payload);
      } catch {
        return; // not ours
      }
      const p = parsed as Record<string, unknown>;
      if (p?.type === 'work') {
        onNotify({ type: 'work' });
        return;
      }
      if (
        p?.type === 'terminal' &&
        typeof p.runId === 'string' &&
        typeof p.projectId === 'string' &&
        typeof p.env === 'string'
      ) {
        onNotify({ type: 'terminal', runId: p.runId, projectId: p.projectId, env: p.env });
      }
    });
    c.on('error', (err) => {
      logger.error(
        '[better-trigger] notification fast-path: connection error',
        err instanceof Error ? err.message : String(err),
      );
      // Do NOT wait for 'end' to schedule the reconnect: some connection
      // failures never emit it. Closing here also surfaces 'end' for the ones
      // that do — scheduleReconnect dedups the pair.
      void c.end().catch(() => {});
      scheduleReconnect();
    });
    c.on('end', () => {
      if (stopping) return;
      logger.warn(
        '[better-trigger] notification fast-path: LISTEN connection lost; ' +
          'reconnecting — polling covers the gap',
      );
      scheduleReconnect();
    });
  }

  void connect();

  return {
    async stop() {
      stopping = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectScheduled = false;
      }
      const c = client;
      client = null;
      if (c) await c.end().catch(() => {});
    },
  };
}
