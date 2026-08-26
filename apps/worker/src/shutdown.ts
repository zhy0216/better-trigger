/* =============================================================================
   @better-trigger/worker — exit paths (C4: split out of main.ts).

   Signals and crashes converge on one function, `handoff()`. main() fills the
   `daemon` record in as each piece comes up, so a fault at any point during
   boot still hands back whatever already exists — and the crash handlers can
   be installed at module load, before there is anything to hand back.

   Handing the claims back (C3, todos/01-correctness.md) rides on the `worker`
   step below: WorkerHandle.stop() releases every claim this process still
   holds and marks the workers row offline once the drain is over. It lives
   there rather than here so all four exit paths — SIGINT, SIGTERM,
   unhandledRejection, uncaughtException — inherit it through the one handoff,
   and so an embedded host that drives the runtime directly gets it too.
   ============================================================================= */
import { describeError, formatCrashContext } from './observability';
import type { WorkerHandle } from './runtime';

/** Pieces to hand back on the way out, in the order they are created. */
interface Daemon {
  server: { close(): void } | null;
  /** The in-process waiter registry (PF2). Stopped right after the server:
   *  it is what rejects pending /result long-polls with the shutdown error,
   *  and server.close() only stops NEW requests — the long-polls already
   *  accepted would otherwise sit out the whole worker drain (30s) before
   *  they are refused. */
  waiters: { stop(): void } | null;
  worker: WorkerHandle | null;
  stopOrchestrator: (() => void) | null;
  /** The dedicated LISTEN connection (PF2). Stopped before the pool: it is
   *  an independent pg.Client, which pool.end() does not close. */
  notify: { stop(): Promise<void> } | null;
  pool: { end(): Promise<void> } | null;
  /** PF4: the dedicated health/metrics probe pool, ended after the business
   *  pool (no new probe requests can arrive once the server is closed). */
  probePool: { end(): Promise<void> } | null;
}
export const daemon: Daemon = {
  server: null,
  waiters: null,
  worker: null,
  stopOrchestrator: null,
  notify: null,
  pool: null,
  probePool: null,
};

/** One exit at a time: a second signal (or a crash mid-drain) must not restart it. */
let exiting = false;

/**
 * A fatal fault happened at some point, whoever ends up owning the exit. A
 * crash that lands *during* a signal drain has nothing left to do — `exiting`
 * is already true — but the process must not then leave with 0 as if the
 * shutdown had been clean. This is that memory.
 */
let fatal = false;

/**
 * Boot-failure path (main's catch): the process must leave non-zero whatever
 * exit path ends up owning it, and `exiting` must already be true before
 * handoff() so the crash handlers do not start a second drain while this one
 * is about to run.
 */
export function markFatal(): void {
  fatal = true;
  exiting = true;
}

/** How long the crash path waits for the handoff before giving up on it. */
const CRASH_HANDOFF_MS = 10_000;

/**
 * How long the signal path waits for the whole shutdown before giving up on
 * it. The runtime's drain is bounded (SHUTDOWN_DRAIN_MS = 30s), so this is the
 * 30s drain plus ~15s of slack for the handoff steps after it (heartbeat stop,
 * releaseClaims, pool.end) — a wedged database must not leave the operator
 * holding SIGKILL.
 */
const SHUTDOWN_BACKSTOP_MS = 45_000;

/**
 * The handoff runs exactly once, and everyone who asks for it awaits the same
 * attempt. Signals, crashes and a failed boot can all reach it, sometimes at
 * the same time (a crash while a SIGTERM drain is in flight, or main().catch()
 * firing while the crash handler already drains) — and a second `pool.end()`
 * throws "Called end on pool more than once", i.e. the fallback path would be
 * the thing that breaks the exit.
 */
let handoffOnce: Promise<void> | null = null;
export function handoff(): Promise<void> {
  handoffOnce ??= runHandoff();
  return handoffOnce;
}

/**
 * A handoff step threw. It stays swallowed — one piece failing to hand itself
 * back must cost neither the remaining pieces their turn nor the process its
 * exit — but a `(failed)` marker in the closing line says only *that* it broke.
 * This says which step and why, which is all anyone gets: the process is gone
 * a moment later, and whatever it failed to hand back (in-flight runs, held
 * leases, open connections) is now the reaper's problem.
 *
 * console.error straight to stderr, like the crash path above it: nothing of
 * ours buffers between the failure and a `process.exit` that may be
 * milliseconds away.
 */
function handoffStepFailed(step: string, err: unknown): void {
  console.error(`[better-trigger] handoff step "${step}" failed: ${describeError(err)}`);
}

/**
 * Stop accepting new work, drain, drop the connections. Never throws: this runs
 * on the crash path too, where a failing handoff step must not swallow the exit.
 * The closing line names the steps that actually ran — proof, in the log of a
 * process that is about to be gone, that the exit went through the handoff
 * rather than straight out.
 */
async function runHandoff(): Promise<void> {
  const steps: string[] = [];
  if (daemon.server) {
    try {
      daemon.server.close();
      steps.push('server');
    } catch (err) {
      handoffStepFailed('server', err);
      steps.push('server(failed)');
    }
  }
  if (daemon.waiters) {
    try {
      daemon.waiters.stop();
      steps.push('waiters');
    } catch (err) {
      handoffStepFailed('waiters', err);
      steps.push('waiters(failed)');
    }
  }
  if (daemon.worker) {
    try {
      await daemon.worker.stop();
      steps.push('worker');
    } catch (err) {
      handoffStepFailed('worker', err);
      steps.push('worker(failed)');
    }
  }
  if (daemon.stopOrchestrator) {
    try {
      daemon.stopOrchestrator();
      steps.push('orchestrator');
    } catch (err) {
      handoffStepFailed('orchestrator', err);
      steps.push('orchestrator(failed)');
    }
  }
  if (daemon.notify) {
    try {
      await daemon.notify.stop();
      steps.push('notify');
    } catch (err) {
      handoffStepFailed('notify', err);
      steps.push('notify(failed)');
    }
  }
  if (daemon.pool) {
    try {
      await daemon.pool.end();
      steps.push('pool');
    } catch (err) {
      handoffStepFailed('pool', err);
      steps.push('pool(failed)');
    }
  }
  if (daemon.probePool) {
    try {
      await daemon.probePool.end();
      steps.push('probePool');
    } catch (err) {
      handoffStepFailed('probePool', err);
      steps.push('probePool(failed)');
    }
  }
  console.log(
    `[better-trigger] handoff complete: ${steps.length > 0 ? steps.join(' ') : 'nothing to hand back'}`,
  );
}

async function shutdown(signal: string): Promise<void> {
  if (exiting) {
    // A second signal while the first drain is still running means the
    // operator wants out NOW — the first signal may be wedged on a half-dead
    // Postgres. Exit immediately instead of ignoring it. (`exiting` may also
    // be set by the crash / boot-failure path, in which case this is the
    // FIRST signal of a shutdown already in progress — same call to arms.)
    console.log(
      `[better-trigger] ${signal} received while a shutdown was already in progress, exiting immediately`,
    );
    process.exit(1);
  }
  exiting = true;
  console.log(`[better-trigger] ${signal} received, draining...`);
  // p1-12 backstop: the drain itself is bounded but the handoff steps after it
  // (heartbeat stop, releaseClaims, pool.end) are not. A wedged database must
  // not leave the operator holding SIGKILL. Kept referenced like the crash
  // backstop.
  const backstop = setTimeout(() => {
    console.error(`[better-trigger] shutdown exceeded ${SHUTDOWN_BACKSTOP_MS}ms, exiting now`);
    process.exit(1);
  }, SHUTDOWN_BACKSTOP_MS);
  await handoff();
  clearTimeout(backstop);
  // A crash can land mid-drain: crash() reports it and steps aside so this
  // drain finishes, which leaves this the only exit left to carry the code.
  process.exit(fatal ? 1 : 0);
}

/**
 * An escaped rejection or an uncaught exception. Node's default is to print a
 * bare stack and vanish, which leaves the leases this process holds to expire
 * on their own and says nothing about what was running. Continuing to serve is
 * not an option after an uncaught exception — but the exit gets the context and
 * the handoff first.
 */
function crash(kind: string, err: unknown): void {
  // Before the early return below: whichever exit path ends up running, it has
  // to leave non-zero now.
  fatal = true;
  console.error(
    formatCrashContext(kind, daemon.worker?.workerId, daemon.worker?.inFlightRunIds() ?? []),
  );
  // The whole error, not `.message`: this is the only record of the fault.
  console.error(describeError(err));

  // Already on the way out (a signal drain, or an earlier crash): reported, and
  // the exit code is taken care of — restarting the handoff would only cut the
  // one already running short.
  if (exiting) return;
  exiting = true;

  // A wedged handoff must not turn "crashed" into "hung". The backstop stays
  // referenced on purpose: it is what guarantees an exit code here, rather than
  // the loop draining empty and the process leaving with 0.
  const backstop = setTimeout(() => {
    console.error(`[better-trigger] handoff exceeded ${CRASH_HANDOFF_MS}ms, exiting now`);
    process.exit(1);
  }, CRASH_HANDOFF_MS);
  void handoff().then(
    () => {
      clearTimeout(backstop);
      process.exit(1);
    },
    () => {
      clearTimeout(backstop);
      process.exit(1);
    },
  );
}

// p1-13: a stray unhandledRejection is most likely a user task's non-awaited
// promise (the daemon loads and executes task modules in-process); it must not
// take down the daemon and every unrelated in-flight run. Counter is
// process-wide so /metrics can see it even before the runtime exists.
export const unhandledRejections = { count: 0 };
/**
 * A rejected promise nobody handled. `uncaughtException` may have corrupted
 * state and exits; a stray rejection has no such claim — Node's own guidance
 * is that the process state is still usable. Record it loudly (with the
 * context of what was running, and a hint at the usual culprit) and keep
 * serving. `BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION=1` restores the old
 * fail-fast behavior for those who want it.
 */
function handleUnhandledRejection(reason: unknown): void {
  if (process.env.BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION === '1') {
    crash('unhandledRejection', reason);
    return;
  }
  unhandledRejections.count += 1;
  // Context WITHOUT the "fatal … exiting" wording — the daemon is neither.
  console.error(
    formatCrashContext(
      'unhandledRejection (non-fatal, daemon keeps serving)',
      daemon.worker?.workerId,
      daemon.worker?.inFlightRunIds() ?? [],
      false,
    ),
  );
  // The whole reason, not `.message`: this is the only record of the fault.
  console.error(
    `[better-trigger] unhandledRejection (${unhandledRejections.count} total; daemon keeps serving — ` +
      `usually a promise in task code that was never awaited):`,
    reason,
  );
}

process.on('unhandledRejection', (reason) => handleUnhandledRejection(reason));
// An uncaught exception may have corrupted state — exiting is the right call.
process.on('uncaughtException', (err) => crash('uncaughtException', err));
// Signals registered at load time so a SIGTERM during boot (loadTasks /
// migrate / registerWorker) also runs the graceful handoff instead of Node's
// default immediate kill.
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
