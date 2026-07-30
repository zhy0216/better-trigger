/* =============================================================================
   @better-trigger/worker — execution runtime.
   register → orchestrator loops (waits / cron / reaper / offline markers)
            → N concurrent claim-and-execute slots (idle backoff + jitter)
            + a heartbeat loop (max(500, leaseMs/3): lease renewal + cancels).
   stop() stops claiming, drains in-flight runs (bounded) and stops the loops;
   process signals are the daemon entry point's business (see main.ts), not
   this module's.
   ============================================================================= */
import { createHash } from 'node:crypto';
import type { ClaimedRun, RetryPolicy } from '@better-trigger/core';
import type {
  Kernel,
  OrchestratorCounters,
  OrchestratorOptions,
} from '@better-trigger/kernel';
import type { TaskHandle } from 'better-trigger';
import {
  toExecutorTask,
  toManifest,
  type ResolvedTaskDefinition,
} from 'better-trigger/internal';
import { Executor } from './executor';
import {
  createThrottledLogger,
  createWorkerCounters,
  errorKey,
  type WorkerCounters,
  type WorkerLogger,
} from './observability';

/** Options accepted by startWorkerRuntime(). */
export interface StartOptions {
  /** Tasks this worker can execute. */
  tasks: Array<TaskHandle<any, any>>;
  /** Number of concurrent execution slots / claim loops. Default 5. */
  concurrency?: number;
  /** Friendly worker name recorded on registration. */
  name?: string;
  /** Lease duration granted per claim (renewed by heartbeat). Default 60s. */
  leaseMs?: number;
}

/** Handle returned by startWorkerRuntime(); lets callers stop it. */
export interface WorkerHandle {
  workerId: string;
  /** Resolves once the worker has fully drained and exited its loops. */
  stop(): Promise<void>;
  /** Run ids executing right now. Snapshot — the daemon reports it when it
   *  crashes, so "which runs died with the process" is in the log. */
  inFlightRunIds(): string[];
  /** Live counters: execution outcomes plus the swallowed-error paths
   *  (heartbeat / claim / execute / report). Read, never written, by whoever
   *  exports metrics. */
  counters: WorkerCounters;
  /** Counters of the orchestrator loops this runtime started (reaper
   *  recoveries, loop errors) — the daemon has no other handle on them. */
  orchestratorCounters: OrchestratorCounters;
  /** Promise that resolves when the claim loops exit. */
  done: Promise<void>;
}

/** What the daemon injects into the worker runtime. */
export interface WorkerDeps {
  kernel: Kernel;
  /** Where the best-effort catches report (see observability.ts). Defaults to
   *  console; an embedded host passes the same sink it gives the kernel. */
  logger?: WorkerLogger;
  /** Quiet window for repeated errors of one kind. Test knob; see
   *  DEFAULT_LOG_THROTTLE_MS. */
  logThrottleMs?: number;
  /** Orchestrator loop intervals (test knobs). */
  orchestrator?: OrchestratorOptions;
  /** Daemon-level default retry, inherited by task definitions without their
   *  own (feeds both registration manifests and executor-side backoff). */
  defaultRetry?: RetryPolicy;
  /** Invoked after all loops stop (any stop path). */
  onStopped?: () => Promise<void>;
}

const DEFAULT_LEASE_MS = 60_000;
const MIN_HEARTBEAT_MS = 500;
const IDLE_POLL_BASE_MS = 300;
const IDLE_POLL_MAX_MS = 2_000;
const SHUTDOWN_DRAIN_MS = 30_000;

export async function startWorkerRuntime(
  deps: WorkerDeps,
  options: StartOptions,
): Promise<WorkerHandle> {
  const { kernel } = deps;
  const concurrency = options.concurrency ?? 5;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const counters = createWorkerCounters();
  const log = createThrottledLogger(deps.logger ?? console, deps.logThrottleMs);

  // Normalize once where definitions enter the runtime: a task without its own
  // retry inherits the instance default (copied — the shared handle definition
  // stays untouched), so the registration manifest (trigger-time max_attempts)
  // and the executor-reported backoff agree instead of the executor silently
  // falling back to the kernel DEFAULT_RETRY timing.
  const definitions = options.tasks.map((t) => {
    const def = t.__definition;
    return def.retry === undefined && deps.defaultRetry !== undefined
      ? { ...def, retry: deps.defaultRetry }
      : def;
  });
  const taskById = new Map<string, ResolvedTaskDefinition<any, any>>();
  for (const def of definitions) taskById.set(def.id, def);
  const taskIds = definitions.map((d) => d.id);

  const codeVersion = resolveCodeVersion(definitions);
  const manifests = definitions.map(toManifest);

  const { workerId } = await kernel.registerWorker({
    name: options.name,
    codeVersion,
    runtime: 'self-host',
    concurrency,
    tasks: manifests,
  });

  // Background loops (wait resumption, cron, lease reaper, offline markers)
  // run inside the worker process and stop with it.
  const orchestrator = kernel.startOrchestrator(deps.orchestrator);

  // Runs currently executing, keyed by run id → their Executor (for cancels).
  const inFlight = new Map<string, Executor>();
  let stopping = false;

  /* ---- heartbeat loop --------------------------------------------------- */
  const heartbeatMs = Math.max(MIN_HEARTBEAT_MS, Math.floor(leaseMs / 3));
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const res = await kernel.heartbeat({
          workerId,
          runIds: [...inFlight.keys()],
          leaseMs,
        });
        counters.consecutiveHeartbeatErrors = 0;
        for (const runId of res.cancelRunIds) {
          inFlight.get(runId)?.markCanceled();
        }
        // C2 (todos/01-correctness.md) plugs in right here: when the heartbeat
        // starts reporting runs whose lease we lost, loop them into
        // `inFlight.get(runId)?.markLost()` so ctx.signal aborts too.
      } catch (err) {
        // Still best-effort — the lease reaper protects correctness, so this
        // must not take the loop down. But a heartbeat that keeps missing means
        // every lease this worker holds is drifting towards being reaped out
        // from under it, and that is not something to find out from the run
        // table hours later.
        counters.heartbeatErrors += 1;
        counters.consecutiveHeartbeatErrors += 1;
        log.warn(
          `heartbeat:${errorKey(err)}`,
          `heartbeat failed ${counters.consecutiveHeartbeatErrors}x in a row ` +
            `(worker=${workerId}, in-flight=${inFlight.size}); leases are not being renewed`,
          err,
        );
      }
    })();
  }, heartbeatMs);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  /* ---- one claim-and-execute loop (a single concurrency slot) ----------- */
  async function claimLoop(slot: number): Promise<void> {
    let idleBackoff = IDLE_POLL_BASE_MS;
    while (!stopping) {
      let run: ClaimedRun | undefined;
      try {
        const claimed = await kernel.claimRuns({ workerId, taskIds, limit: 1, leaseMs });
        counters.consecutiveClaimErrors = 0;
        run = claimed[0];
      } catch (err) {
        counters.claimErrors += 1;
        counters.consecutiveClaimErrors += 1;
        if (stopping) break;
        // A failing claim is indistinguishable from an idle queue from the
        // outside — the dashboard just never moves. Say it out loud (throttled:
        // a dead DB would otherwise print once per poll, per slot).
        log.warn(
          `claim:${errorKey(err)}`,
          `claim failed ${counters.consecutiveClaimErrors}x in a row ` +
            `(worker=${workerId}, slot=${slot}); no runs are being picked up`,
          err,
        );
        // DB hiccup: back off like an idle poll before retrying.
        await sleep(jittered(idleBackoff));
        idleBackoff = Math.min(IDLE_POLL_MAX_MS, idleBackoff * 2);
        continue;
      }

      if (!run) {
        // Nothing due: exponential idle backoff 300ms → 2s, ± jitter.
        await sleep(jittered(idleBackoff));
        idleBackoff = Math.min(IDLE_POLL_MAX_MS, idleBackoff * 2);
        continue;
      }
      idleBackoff = IDLE_POLL_BASE_MS; // got work — claim again immediately after

      const def = taskById.get(run.taskId);
      if (!def) {
        // Should not happen (the claim filters by this worker's task ids);
        // skip safely — the lease reaper recovers the abandoned claim.
        continue;
      }

      const executor = new Executor(kernel, toExecutorTask(def), run, workerId, {
        log,
        counters,
      });
      inFlight.set(run.id, executor);
      try {
        const result = await executor.execute();
        // The one place every execution pass funnels through, so it is where
        // the outcome mix gets counted. Indexed by the Executor's own result
        // type: a new variant there fails to compile here rather than going
        // uncounted.
        counters.runOutcomes[result.type] += 1;
      } catch (err) {
        // Executor handles its own errors; this guards the loop only. Reaching
        // here means it did not — a bug in the executor, or a kernel write that
        // failed for a reason it does not classify. The run keeps its lease and
        // comes back through the reaper, so name it before it disappears.
        counters.executorErrors += 1;
        log.warn(
          `executor:${errorKey(err)}`,
          `executor threw out of run ${run.id} (task=${run.taskId}, attempt=${run.attempt}, ` +
            `slot=${slot}); the run is left to the lease reaper`,
          err,
        );
      } finally {
        inFlight.delete(run.id);
      }
    }
  }

  const loops = Array.from({ length: concurrency }, (_, slot) => claimLoop(slot));
  const loopsDone = Promise.all(loops).then(() => undefined);

  /* ---- graceful shutdown ------------------------------------------------ */
  let stopPromise: Promise<void> | null = null;
  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      // Tell every in-flight step it can stop: ctx.signal aborts with reason
      // 'shutting_down', so a fetch / SDK call wired to it fails immediately
      // rather than holding the drain window open for a result this process will
      // never report. Those runs keep their 'running' row and their lease and
      // are requeued by the reaper — the SIGKILL recovery path, minus the wait.
      // Steps that ignore the signal still get the full drain window.
      for (const executor of inFlight.values()) executor.markShuttingDown();
      // Claim loops exit at the next check; in-flight runs drain, bounded by
      // SHUTDOWN_DRAIN_MS. The heartbeat stays alive during the drain so
      // leases keep renewing while runs finish.
      await Promise.race([loopsDone, sleep(SHUTDOWN_DRAIN_MS)]);
      clearInterval(heartbeatTimer);
      orchestrator.stop();
      await deps.onStopped?.();
    })();
    return stopPromise;
  }

  return {
    workerId,
    stop,
    inFlightRunIds: () => [...inFlight.keys()],
    counters,
    orchestratorCounters: orchestrator.counters,
    done: loopsDone,
  };
}

/**
 * Derive a stable code version from env, or from a hash of the task set: ids +
 * cron config + **a fingerprint of each run function's source**.
 *
 * The body hash is the point: replay keys steps by position, so editing a run()
 * — inserting a step, moving a wait — is exactly what invalidates in-flight
 * ledgers, and a version that ignores the body reports "same code" across
 * precisely the deploy that could corrupt them. Same source on two processes →
 * same version; a changed body → a new version, visible on runs.code_version
 * and workers.code_version.
 *
 * Caveat: source text also changes under a different bundler/minifier without
 * any semantic change, so a rebuild can churn the version. Set
 * BETTER_TRIGGER_VERSION (git sha, image tag) to take over completely.
 */
export function resolveCodeVersion(
  definitions: Array<ResolvedTaskDefinition<any, any>>,
): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.BETTER_TRIGGER_VERSION;
  if (env) return env;

  const signature = definitions
    .map((d) => {
      const cron = d.cron ? `${d.cron.pattern}@${d.cron.timezone ?? ''}` : '';
      return `${d.id}|${cron}|${fingerprintFn(d.run)}`;
    })
    .sort()
    .join('\n');
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 12);
  return `v_${hash}`;
}

/** Short hash of a function's source. Native/bound fns hash their placeholder
 *  source ("[native code]") — stable, just not discriminating. */
function fingerprintFn(fn: unknown): string {
  const source = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/** Multiply a delay by [0.8, 1.2) so idle slots do not poll in lockstep. */
function jittered(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
