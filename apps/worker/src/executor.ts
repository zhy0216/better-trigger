/* =============================================================================
   @better-trigger/worker — replay executor (the core of the runtime).
   Implements docs/backend-contract.md §3.1–§3.4 and §3.8.

   One Executor instance drives a single execution of a task's run() function:
     - a monotonic seq counter is consumed by every durable primitive;
     - a snapshot Map<seq, StepSnapshot> short-circuits completed steps;
     - failures are reported and the execution ends via an internal signal;
     - waits / triggerAndWait suspend by throwing SuspendSignal (caught here).

   Every kernel write carries this claim's { workerId, fencingToken }; a
   run_not_running / stale_lease rejection means the run moved on without us
   and the executor abandons silently.

   The executor publishes itself into `better-trigger`'s AsyncLocalStorage so
   TaskHandles created in user code can detect "am I inside a run?" and become
   durable steps instead of HTTP triggers. That storage lives in the SDK
   package precisely so both sides see the same one.
   ============================================================================= */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  AbortError,
  durationToDate,
  isAbortError,
  isExecutionEndedSignal,
  isNonDeterminismError,
  isSuspendSignal,
  KernelError,
  serializeError,
  SuspendSignal,
  type ClaimedRun,
  type ExecutionEndedSignal,
  type LogEntry,
  type RetryPolicy,
  type StepKind,
  type StepSnapshot,
  type TaskRunResult,
  type TriggerItem,
  type TriggerOptions,
} from '@better-trigger/core';
import { fnSourceHash, stepFingerprint, type Kernel } from '@better-trigger/kernel';
import {
  RunAbortedError,
  type RunAbortReason,
  type RunCtx,
  type RunInfo,
  type StepOptions,
} from 'better-trigger';
import {
  executorStorage,
  type ExecutorTask,
  type RunExecutor,
} from 'better-trigger/internal';
import { errorKey, type ExecutorDiagnostics } from './observability';

/**
 * Thrown internally to unwind the run() stack after a fatal failure was
 * reported. The class stays private (user code never constructs one), but its
 * brand is core's `ExecutionEndedSignal` so `isControlFlowSignal` — the
 * predicate we tell users to rethrow on — recognizes it: `implements` is what
 * keeps the two in step.
 */
class ExecutionDone extends Error implements ExecutionEndedSignal {
  readonly isBetterTriggerExecutionDone = true;
  constructor() {
    super('execution complete');
    this.name = 'ExecutionDone';
  }
}

/**
 * Kernel rejections that mean this attempt may no longer write: the run left
 * 'running' (canceled / resumed elsewhere / terminal) or the claim's fencing
 * token went stale (lease reaped, run reclaimed). Both → abandon silently.
 */
function isAbandonment(err: unknown): boolean {
  return (
    err instanceof KernelError &&
    (err.code === 'run_not_running' || err.code === 'stale_lease')
  );
}

/** Outcome of a single execution pass. */
export type ExecutionResult =
  | { type: 'completed'; output: unknown }
  | { type: 'failed' }
  | { type: 'suspended' }
  | { type: 'abandoned' }; // run no longer running / lease lost — give up silently

const LOG_FLUSH_INTERVAL_MS = 1_000;
const LOG_FLUSH_THRESHOLD = 50;

export class Executor implements RunExecutor {
  private seq = 0;
  private readonly snapshot = new Map<number, StepSnapshot>();
  /**
   * Seq of the step whose fn is lexically executing, for attaching logs and
   * guarding against nested durable primitives. Backed by AsyncLocalStorage so
   * a step's whole async continuation sees its own seq while parallel siblings
   * (e.g. Promise.all([ctx.step(...), ctx.step(...)])) stay independent.
   */
  private readonly stepAls = new AsyncLocalStorage<number>();
  private logBuffer: LogEntry[] = [];
  private logTimer: ReturnType<typeof setInterval> | null = null;
  /** Set true once a kernel write is rejected (run_not_running / stale_lease). */
  private abandoned = false;
  /**
   * Which control-flow signal we have already thrown into user code, if any:
   * 'suspend' = SuspendSignal (the run is 'waiting'), 'done' = ExecutionDone
   * (this attempt is over). Non-null means nothing this execution does may
   * still be recorded — see assertSignalNotSwallowed (C6).
   */
  private endSignal: 'suspend' | 'done' | null = null;
  /** Set by the worker when a heartbeat reports a cancel for this run. */
  private canceled = false;
  /**
   * Backs ctx.signal: aborted the moment this attempt's work stops being worth
   * anything, so a step fn blocked on an LLM / tool call can bail out instead of
   * running to completion for an output that is already discarded. Cancellation
   * itself is still enforced at step boundaries (checkCanceled) — the signal is
   * a cooperative fast path, never the mechanism.
   */
  private readonly aborter = new AbortController();
  /** Non-null once `aborter` fired; also the discriminator for "our own abort". */
  private abortReason: RunAbortReason | null = null;

  readonly ctx: RunCtx;

  constructor(
    private readonly kernel: Kernel,
    private readonly task: ExecutorTask,
    private readonly run: ClaimedRun,
    private readonly workerId: string,
    /** Sink + counters for the catches below that report nothing to the kernel
     *  (a failed-step row that never landed, a failure that never landed,
     *  dropped logs). Required, and explicitly nullable: `null` opts out (a
     *  unit test constructing an Executor directly does not need one), but a
     *  future second construction site has to say so rather than degrade to
     *  silence by leaving an optional argument off. */
    private readonly diagnostics: ExecutorDiagnostics | null,
  ) {
    for (const s of run.steps) this.snapshot.set(s.seq, s);
    const runInfo: RunInfo = {
      id: run.id,
      taskId: run.taskId,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      env: run.env,
    };
    this.ctx = this.buildCtx(runInfo);
  }

  /** Worker calls this on the heartbeat cancel path; checked at step boundaries. */
  markCanceled(): void {
    this.canceled = true;
    this.abort('canceled');
  }

  /**
   * Worker calls this when the daemon starts draining (runtime.stop()). Only
   * ctx.signal is touched: the run keeps its 'running' row and its lease, and is
   * requeued by the lease reaper exactly as it would be after a SIGKILL — we
   * just stop waiting out SHUTDOWN_DRAIN_MS for a call whose result this process
   * will never report.
   */
  markShuttingDown(): void {
    this.abort('shutting_down');
  }

  /**
   * Worker calls this when a heartbeat reports our claim on this run is gone
   * (todos/01-correctness.md C2) — reaped away, or the queue row vanished under
   * us. Only ctx.signal is touched, on purpose: whoever holds the claim now is
   * responsible for the run, and every write from here would be fenced off
   * anyway. We just stop paying for it.
   */
  markLost(): void {
    this.abort('lease_lost');
  }

  /** First reason wins: an abort already delivered is not re-labelled. */
  private abort(reason: RunAbortReason): void {
    if (this.abortReason !== null) return;
    this.abortReason = reason;
    this.aborter.abort(new RunAbortedError(reason));
  }

  /**
   * The error we are about to report is really our own abort landing in user
   * code, so do not write it as a step/run failure: for 'canceled' the kernel
   * would reject the write anyway, and for 'shutting_down' / 'lease_lost' a
   * failed row would burn an attempt on a handover. Abandon silently instead.
   */
  private abandonIfAborted(): void {
    if (this.abortReason !== null) {
      this.abandoned = true;
      throw this.endExecution();
    }
  }

  /* ---- execution entry point ------------------------------------------- */

  async execute(): Promise<ExecutionResult> {
    this.startLogTimer();
    try {
      // Payload validation: failure is non-retryable (treated as AbortError).
      let payload: unknown = this.run.payload;
      if (this.task.validate) {
        try {
          payload = await this.task.validate(this.run.payload);
        } catch (err) {
          await this.failRun(serializeError(err), undefined, true, undefined);
          return { type: 'failed' };
        }
      }

      let output: unknown;
      try {
        output = await executorStorage.run(this, () => this.task.run(payload, this.ctx));
      } catch (err) {
        return this.handleThrown(err);
      }

      // Normal return → complete. Unless run() only returned because a catch-all
      // swallowed the signal that was supposed to end it (C6) and no durable
      // primitive followed to catch it out: the run is already 'waiting' /
      // finished, so completing it here is exactly the write that must not
      // happen. Report the outcome that actually holds instead.
      if (this.endSignal !== null) return this.endedWithoutUs();
      if (this.abandoned) return { type: 'abandoned' };
      await this.flushLogs();
      try {
        await this.kernel.completeRun({
          runId: this.run.id,
          output,
          workerId: this.workerId,
          fencingToken: this.run.fencingToken,
        });
      } catch (err) {
        if (isAbandonment(err)) return { type: 'abandoned' };
        throw err;
      }
      return { type: 'completed', output };
    } finally {
      this.stopLogTimer();
    }
  }

  /** Classify a thrown value from run()/between-step code into an outcome. */
  private async handleThrown(err: unknown): Promise<ExecutionResult> {
    // SuspendSignal: wait / triggerAndWait already recorded in the kernel.
    if (isSuspendSignal(err)) {
      await this.flushLogs();
      return { type: 'suspended' };
    }
    // ExecutionDone: a step failure path already reported fail() — just unwind.
    // The abandonment paths (kernel rejection, cancel, ctx.signal abort) unwind
    // the same way but reported nothing, so keep them distinguishable.
    if (isExecutionEndedSignal(err)) {
      return this.abandoned ? { type: 'abandoned' } : { type: 'failed' };
    }
    if (this.abandoned) return { type: 'abandoned' };
    // Our own abort surfacing between steps (canceled / draining / lease lost):
    // same reasoning as abandonIfAborted() — hand the attempt back, do not fail.
    if (this.abortReason !== null) return { type: 'abandoned' };
    // Error thrown between steps (not inside ctx.step): fail the run, no
    // stepSeq. The task-level retry policy (own or inherited instance default)
    // still governs the backoff, same as the step-failure path.
    const abort = isAbortError(err);
    await this.failRun(serializeError(err), undefined, abort, abort ? undefined : this.task.retry);
    return this.abandoned ? { type: 'abandoned' } : { type: 'failed' };
  }

  /**
   * run() returned normally even though we had already thrown a signal into it,
   * so the return value is worth nothing: the run is suspended (or this attempt
   * already failed) and user code simply kept going after swallowing the throw.
   * Leave a trace in the run's logs and report the outcome the signal stood for.
   */
  private async endedWithoutUs(): Promise<ExecutionResult> {
    const signal = this.endSignal === 'suspend' ? 'suspend signal' : 'end-of-execution signal';
    this.log(
      'warn',
      `run() returned normally after this execution ended — your code caught the ` +
        `${signal} instead of rethrowing it. Its return value is discarded, and ` +
        `everything after the catch ran outside the run: unrecorded, and again on ` +
        `replay. Rethrow it: if (isControlFlowSignal(err)) throw err.`,
    );
    await this.flushLogs();
    if (this.endSignal === 'suspend') return { type: 'suspended' };
    return this.abandoned ? { type: 'abandoned' } : { type: 'failed' };
  }

  /* ---- ctx construction ------------------------------------------------ */

  private buildCtx(runInfo: RunInfo): RunCtx {
    return {
      run: runInfo,
      step: (label, fn, opts) => this.doStep(label, fn, opts),
      wait: {
        // The fingerprint hashes the DECLARED wait, not the computed instant:
        // ctx.wait.for('24h') must fingerprint as '24h' on every replay, while
        // the absolute resumeAt is recomputed from wall-clock time each time
        // and would drift the ledger (C1).
        for: (duration) => this.doWait('duration', durationToDate(duration), { duration }),
        until: (date) => this.doWait('until', date, { until: date.toISOString() }),
      },
      logger: {
        debug: (m, d) => this.log('debug', m, d),
        info: (m, d) => this.log('info', m, d),
        warn: (m, d) => this.log('warn', m, d),
        error: (m, d) => this.log('error', m, d),
      },
      // One signal per execution: built here, so a replayed run gets a fresh one
      // and memoized steps (which never re-run) simply never observe it.
      signal: this.aborter.signal,
      now: () => this.doDeterministic('now'),
      random: () => this.doDeterministic('random'),
      uuid: () => this.doDeterministic('uuid'),
    };
  }

  /* ---- seq + snapshot helpers ------------------------------------------ */

  private nextSeq(): number {
    return this.seq++;
  }

  /**
   * A snapshot row counts as a cache hit only if it completed.
   *
   * Before handing the row back, check that it actually belongs to this call
   * site. Replay keys steps by position alone, so a run() edited while runs are
   * in flight (the long-wait case: a ledger can outlive several deploys) will
   * happily feed seq N's row to whatever primitive now sits at seq N. `kind` is
   * the reliable signal — it is derived from the primitive, not from user text,
   * so a wait row arriving at a ctx.step() call is unambiguous corruption.
   * `label` is the softer one (renames are innocent, inserts are not).
   *
   * The C1 replay fingerprint is the semantic check on top: when kind + label
   * agree, the row still only belongs to this call site if the code/inputs
   * that recorded it produce the same signature today.
   *
   *   - NULL fingerprint (a ledger written before fingerprints existed, or a
   *     wait created before this deploy) → cannot be drift-checked: replay
   *     leniently with one compatibility notice, whatever the replay mode.
   *   - non-NULL mismatch → the recorded output belongs to different code or
   *     inputs: fail the run with a non-retryable AbortError REGARDLESS of
   *     replay:'strict'. Retrying would only replay the same mismatch, and
   *     feeding the old output to the new code is the exact failure C1 exists
   *     to prevent — so there is no lenient reading of it. Kind/label drifts
   *     below keep their existing strict/lenient split.
   */
  private cached(
    seq: number,
    expectedKind: StepKind,
    expectedLabel: string | null,
    expectedFingerprint: string,
  ): StepSnapshot | undefined {
    const snap = this.snapshot.get(seq);
    if (!snap || snap.status !== 'completed') return undefined;

    if (snap.kind !== expectedKind) {
      this.onReplayDrift(seq, `kind '${snap.kind}' → '${expectedKind}'`);
    } else if (expectedLabel != null && snap.label != null && snap.label !== expectedLabel) {
      this.onReplayDrift(seq, `label "${snap.label}" → "${expectedLabel}"`);
    } else {
      const stored = snap.fingerprint ?? null;
      if (stored === null) {
        this.onLegacyFingerprint(seq, expectedKind, expectedLabel);
      } else if (stored !== expectedFingerprint) {
        const what =
          expectedKind === 'step' && expectedLabel
            ? `step "${expectedLabel}"`
            : `${expectedKind}${expectedLabel ? ` "${expectedLabel}"` : ''}`;
        throw new AbortError(
          `replay fingerprint mismatch at seq ${seq} (${what}): recorded "${stored}", ` +
            `this call site computes "${expectedFingerprint}" — the step's code or its ` +
            `inputs changed after it was recorded, so the recorded output is no longer ` +
            `this code's result. task "${this.task.id}"'s run ${this.run.id} is failed ` +
            `instead of replaying a stale step row. Retry it under a fresh run, or ` +
            `cancel it if the work is obsolete.`,
        );
      }
    }
    return snap;
  }

  /**
   * This run's ledger predates replay fingerprints (C1): the completed row at
   * this seq has no fingerprint to compare, so replay uses it as-is. Said once
   * per execution, not per row — one notice is the migration story, fifty is
   * noise. Nothing needs migrating: new writes carry fingerprints, and the
   * legacy rows simply cannot be drift-checked.
   */
  private legacyFingerprintNoted = false;

  private onLegacyFingerprint(seq: number, kind: StepKind, label: string | null): void {
    if (this.legacyFingerprintNoted) return;
    this.legacyFingerprintNoted = true;
    this.log(
      'warn',
      `run ${this.run.id} replays step rows recorded before replay fingerprints ` +
        `(NULL fingerprint at seq ${seq}, ${kind}${label ? ` "${label}"` : ''}) — ` +
        `those rows cannot be drift-checked, so their recorded output is used ` +
        `as-is. New writes carry fingerprints; nothing needs migrating.`,
    );
  }

  /**
   * C1 replay fingerprint for THIS call site: primitive kind, label, the
   * persistable inputs and the run's code version. Must be byte-identical to
   * what the kernel recorded for the same primitive — the canonical algorithm
   * lives in packages/kernel/src/fingerprint.ts, and the kernel write paths
   * (suspendRun, waitForChildRun, batchTriggerChild) persist this exact value
   * so the completed step row and the replay's comparison agree while a
   * semantic input change (a step fn's source, a payload, the declared wait)
   * drifts.
   */
  private fingerprint(kind: StepKind, label: string | null, input: unknown): string {
    return stepFingerprint({
      kind,
      label,
      input,
      codeVersion: this.run.codeVersion,
    });
  }

  /**
   * Snapshot row and call site disagree at the same seq. Strict → non-retryable
   * AbortError (retrying replays the same mismatched ledger, so a backoff loop
   * would only delay the same wrong answer). Lenient → warn and carry on.
   */
  private onReplayDrift(seq: number, detail: string): void {
    const summary = `replay drift at seq ${seq}: ${detail}`;
    if (this.task.replay === 'strict') {
      throw new AbortError(
        `${summary} — the recorded ledger no longer matches this task's code ` +
          `(a durable primitive was inserted, removed or reordered). ` +
          `task "${this.task.id}" declares replay:'strict', so run ${this.run.id} is failed ` +
          `instead of replaying a foreign step row. Retry it under a new task id, ` +
          `or cancel it if the work is obsolete.`,
      );
    }
    this.log('warn', summary);
  }

  private checkCanceled(): void {
    if (this.canceled) {
      this.abandoned = true;
      throw this.endExecution();
    }
  }

  /**
   * The only way ExecutionDone is created: records that a control-flow signal
   * is now in flight through user code, so a catch-all that swallows it is
   * detectable at the next durable primitive.
   */
  private endExecution(): ExecutionDone {
    this.endSignal = 'done';
    return new ExecutionDone();
  }

  /**
   * Suspending and ending an attempt are delivered by throwing (SuspendSignal,
   * ExecutionDone). A catch-all in user code swallows them and keeps going:
   *
   *     try { await ctx.wait.for('1h') } catch {}
   *     await sendEmail(user)              // ← really sends, right now
   *
   * suspendRun already flipped the run to 'waiting' and dropped its queue row,
   * so every later kernel write is fenced off and the executor abandons in
   * silence — but the side effects between the catch and the end of run() do
   * happen, and happen again after the run resumes and replays, with nothing in
   * the ledger to show for it (todos/01-correctness.md C6).
   *
   * Plain side effects are out of reach, but the moment a durable primitive is
   * called we know the signal was swallowed: say so, in the run's own logs and
   * in the error. AbortError on purpose — this is a deterministic bug in the
   * task, so retrying would only replay it — and it stays consistent with T6:
   * if this attempt was already abandoned or aborted, handleThrown classifies
   * the throw as 'abandoned' and still reports nothing.
   */
  private async assertSignalNotSwallowed(what: string): Promise<void> {
    if (this.endSignal === null) return;
    const caught =
      this.endSignal === 'suspend'
        ? 'your code caught the suspend signal thrown by ctx.wait() / triggerAndWait()'
        : 'your code caught the internal end-of-execution signal';
    const summary = `${what} was called after this execution ended — ${caught}`;
    this.log(
      'warn',
      `${summary}. Everything after that catch is running outside the run: it ` +
        `records nothing, and it runs again when the run replays. ` +
        `Rethrow it: if (isControlFlowSignal(err)) throw err.`,
    );
    // Reach the user before the throw is classified: the abandonment paths in
    // handleThrown return without flushing, and this warning is the only trace.
    await this.flushLogs();
    throw new AbortError(
      `${summary}. A catch-all around a durable primitive swallows the signal ` +
        `that ends the execution, so run ${this.run.id} kept executing while it ` +
        `was already suspended or finished — no write from here on is recorded, ` +
        `and the code after the catch runs a second time on replay. ` +
        `Rethrow it: catch (err) { if (isControlFlowSignal(err)) throw err; ... } ` +
        `— isControlFlowSignal is exported from "better-trigger" and covers both ` +
        `signals (suspend and end-of-execution), so one rethrow fixes both paths. ` +
        `Or move the durable primitive out of the try block: a step that fails is ` +
        `retried by its retry policy, there is no "carry on anyway" for it.`,
    );
  }

  /**
   * Durable primitives must not be nested inside a step fn: the inner call
   * would consume a seq that is silently skipped when the outer step replays
   * from cache, shifting every later position key. Fail loudly instead.
   */
  private assertNotNested(what: string): void {
    const activeStepSeq = this.stepAls.getStore();
    if (activeStepSeq !== undefined) {
      // AbortError: a deterministic programming error — retrying cannot help.
      throw new AbortError(
        `${what} cannot be called inside ctx.step() (seq ${activeStepSeq}): ` +
          `nesting durable primitives breaks replay positions. ` +
          `Move it outside the step — plain Date/Math.random ARE safe inside a step, ` +
          `its output is memoized.`,
      );
    }
  }

  /* ---- ctx.step -------------------------------------------------------- */

  private async doStep<T>(
    label: string,
    fn: () => T | Promise<T>,
    opts?: StepOptions,
  ): Promise<T> {
    await this.assertSignalNotSwallowed(`ctx.step("${label}")`);
    if (this.abandoned) throw this.endExecution();
    this.assertNotNested(`ctx.step("${label}")`);
    const seq = this.nextSeq();
    // fn source hash is the persistable stand-in for the fn itself (its output
    // semantics): an edited step body must not replay its old result.
    const fp = this.fingerprint('step', label, {
      fn: fnSourceHash(fn),
      ...(opts !== undefined ? { opts } : {}),
    });

    const hit = this.cached(seq, 'step', label, fp);
    if (hit) return hit.output as T;

    this.checkCanceled();

    const startedAt = new Date().toISOString();
    let result: T;
    try {
      // Run fn under the step's seq: its whole async continuation attributes
      // logs to this seq and trips assertNotNested, while parallel siblings get
      // their own independent store (so Promise.all of two steps is allowed).
      result = await this.stepAls.run(seq, () => fn());
    } catch (err) {
      // fn already threw → we are outside stepAls.run here; getStore() is
      // undefined, so onStepError's logs are not mis-attributed to this seq.
      await this.onStepError(seq, label, 'step', err, opts?.retry, startedAt, fp);
      // onStepError always reports + throws; unreachable, but satisfies types.
      throw this.endExecution();
    }

    await this.reportStep(seq, 'step', label, 'completed', result, startedAt, fp);
    return result;
  }

  /**
   * Step fn threw: write the failed step row, then fail the run with the
   * effective retry policy, then unwind via ExecutionDone. AbortError → abort:true.
   */
  private async onStepError(
    seq: number,
    label: string,
    kind: StepKind,
    err: unknown,
    stepRetry: RetryPolicy | undefined,
    startedAt: string,
    fingerprint: string,
  ): Promise<void> {
    // ctx.signal fired mid-step: the throw is the abort, not a step failure.
    this.abandonIfAborted();

    const serialized = serializeError(err);
    const abort = isAbortError(err);

    // Best-effort record the failed step row (status='failed').
    try {
      await this.kernel.reportStep({
        runId: this.run.id,
        seq,
        kind,
        label,
        status: 'failed',
        error: serialized,
        attempt: this.run.attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        fingerprint,
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (e) {
      if (isAbandonment(e)) {
        this.abandoned = true;
        throw this.endExecution();
      }
      // Non-fatal: still try to fail the run below. The run does land as
      // failed, so this is not silent from the outside — but the step row that
      // says *where* it failed is gone, and a run whose timeline stops before
      // the failing step reads as a task that failed for no reason.
      const d = this.diagnostics;
      if (d) {
        d.counters.stepReportErrors += 1;
        d.log.warn(
          `step-report:${errorKey(e)}`,
          `failed-step report failed for run ${this.run.id} ` +
            `(task=${this.run.taskId}, seq=${seq}, label=${label ?? kind}); ` +
            'the run still fails, but this step is missing from its timeline',
          e,
        );
      }
    }

    const effectiveRetry = abort ? undefined : (stepRetry ?? this.task.retry);
    await this.failRun(serialized, seq, abort, effectiveRetry);
    throw this.endExecution();
  }

  private async reportStep(
    seq: number,
    kind: StepKind,
    label: string | null,
    status: 'completed' | 'failed',
    output: unknown,
    startedAt: string,
    fingerprint: string,
  ): Promise<void> {
    try {
      await this.kernel.reportStep({
        runId: this.run.id,
        seq,
        kind,
        label: label ?? undefined,
        status,
        output,
        attempt: this.run.attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        fingerprint,
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw this.endExecution();
      }
      if (isNonDeterminismError(err)) {
        // The kernel refused to overwrite a completed step row whose recorded
        // fingerprint differs from ours: the code or its inputs changed under
        // the ledger. Like strict replay drift, retrying would only replay the
        // same mismatch forever — fail the run non-retryably. The kernel has
        // already left the recorded row intact.
        throw new AbortError(err.message);
      }
      throw err;
    }
  }

  /* ---- ctx.wait -------------------------------------------------------- */

  private async doWait(
    kind: 'duration' | 'until',
    resumeAt: Date,
    declared: { duration: string | number } | { until: string },
  ): Promise<void> {
    const what = `ctx.wait.${kind === 'duration' ? 'for' : 'until'}()`;
    await this.assertSignalNotSwallowed(what);
    if (this.abandoned) throw this.endExecution();
    this.assertNotNested(what);
    const seq = this.nextSeq();

    // Fingerprint of the DECLARED wait — passed to suspendRun so the waits row
    // and the completed step row carry it, and recomputed identically on replay.
    const fp = this.fingerprint('wait', null, declared);
    if (this.cached(seq, 'wait', null, fp)) return; // already resumed on a prior replay
    this.checkCanceled();

    let resumed: boolean;
    try {
      const res = await this.kernel.suspendRun({
        runId: this.run.id,
        seq,
        kind,
        resumeAt: resumeAt.toISOString(),
        fingerprint: fp,
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
      resumed = res.resumed;
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw this.endExecution();
      }
      throw err;
    }

    if (resumed) return; // resumeAt already past — keep executing, seq consumed
    this.endSignal = 'suspend'; // from here the run is 'waiting': nothing may write
    throw new SuspendSignal(seq);
  }

  /* ---- triggerAndWait (called by a TaskHandle inside a run) ------------- */

  async triggerAndWait<TOutput>(
    taskId: string,
    payload: unknown,
    label: string,
    options?: TriggerOptions,
  ): Promise<TaskRunResult<TOutput>> {
    await this.assertSignalNotSwallowed(`triggerAndWait("${taskId}")`);
    if (this.abandoned) throw this.endExecution();
    this.assertNotNested(`triggerAndWait("${taskId}")`);
    const seq = this.nextSeq();

    // Label stays NULL in the ledger row and out of the fingerprint (the row
    // never stores it); kind + taskId + payload + options + code version is
    // the full signature, persisted on the waits row by waitForChildRun so
    // wakeParentIfWaiting stamps the completed step with this exact value.
    const fp = this.fingerprint('trigger-and-wait', null, { taskId, payload, options });
    const hit = this.cached(seq, 'trigger-and-wait', label, fp);
    if (hit) return hit.output as TaskRunResult<TOutput>;
    this.checkCanceled();

    try {
      await this.kernel.waitForChildRun({
        runId: this.run.id,
        seq,
        label,
        taskId,
        payload,
        options,
        fingerprint: fp,
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw this.endExecution();
      }
      throw err;
    }
    this.endSignal = 'suspend'; // waiting on the child run — same as ctx.wait
    throw new SuspendSignal(seq);
  }

  /* ---- batch / single trigger inside a run (durable batch-trigger step) - */

  async durableBatchTrigger(
    items: TriggerItem[],
    label: string,
  ): Promise<string[]> {
    await this.assertSignalNotSwallowed(`trigger/batchTrigger (${label})`);
    if (this.abandoned) throw this.endExecution();
    this.assertNotNested(`trigger/batchTrigger (${label})`);
    const seq = this.nextSeq();

    // Same items + label the kernel's batchTriggerChild fingerprints the row
    // with — a changed fan-out must not replay the old run ids.
    const fp = this.fingerprint('batch-trigger', label, { items });
    const hit = this.cached(seq, 'batch-trigger', label, fp);
    if (hit) {
      const out = hit.output as { runIds?: string[] } | string[];
      return Array.isArray(out) ? out : (out.runIds ?? []);
    }
    this.checkCanceled();

    try {
      const res = await this.kernel.batchTriggerChild({
        runId: this.run.id,
        seq,
        label,
        items,
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
      return res.runIds;
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw this.endExecution();
      }
      throw err;
    }
  }

  /* ---- deterministic substitutes (now / random / uuid) ----------------- */

  private async doDeterministic(kind: 'now'): Promise<Date>;
  private async doDeterministic(kind: 'random'): Promise<number>;
  private async doDeterministic(kind: 'uuid'): Promise<string>;
  private async doDeterministic(
    kind: 'now' | 'random' | 'uuid',
  ): Promise<Date | number | string> {
    await this.assertSignalNotSwallowed(`ctx.${kind}()`);
    if (this.abandoned) throw this.endExecution();
    this.assertNotNested(`ctx.${kind}()`);
    const seq = this.nextSeq();

    const fp = this.fingerprint(kind, null, {});
    const hit = this.cached(seq, kind, null, fp);
    if (hit) {
      if (kind === 'now') return new Date(hit.output as string);
      return hit.output as number | string;
    }
    this.checkCanceled();

    const startedAt = new Date().toISOString();
    let value: Date | number | string;
    let stored: unknown;
    if (kind === 'now') {
      value = new Date();
      stored = (value as Date).toISOString();
    } else if (kind === 'random') {
      value = Math.random();
      stored = value;
    } else {
      value = randomUUID();
      stored = value;
    }

    await this.reportStep(seq, kind, null, 'completed', stored, startedAt, fp);
    return value;
  }

  /* ---- run-level fail -------------------------------------------------- */

  private async failRun(
    error: ReturnType<typeof serializeError>,
    stepSeq: number | undefined,
    abort: boolean,
    retry: RetryPolicy | undefined,
  ): Promise<void> {
    await this.flushLogs();
    try {
      await this.kernel.failRun({
        runId: this.run.id,
        error,
        stepSeq,
        retry,
        abort,
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        return;
      }
      // Swallow: failing to report a failure should not crash the worker loop.
      // It does mean the run stays 'running' with a failure nobody recorded
      // until the lease reaper requeues it, so the reason it did not land is
      // the only trace of what happened to this attempt.
      const d = this.diagnostics;
      if (d) {
        d.counters.failReportErrors += 1;
        d.log.warn(
          `fail-report:${errorKey(err)}`,
          `failRun report failed for run ${this.run.id} ` +
            `(task=${this.run.taskId}, attempt=${this.run.attempt}); ` +
            'the failure was not recorded — the lease reaper will requeue it',
          err,
        );
      }
    }
  }

  /* ---- logging --------------------------------------------------------- */

  private log(level: LogEntry['level'], message: string, data?: unknown): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message };
    if (data !== undefined) entry.data = data;
    const activeStepSeq = this.stepAls.getStore();
    if (activeStepSeq !== undefined) entry.stepSeq = activeStepSeq;
    this.logBuffer.push(entry);
    if (this.logBuffer.length >= LOG_FLUSH_THRESHOLD) {
      void this.flushLogs();
    }
  }

  private startLogTimer(): void {
    this.logTimer = setInterval(() => void this.flushLogs(), LOG_FLUSH_INTERVAL_MS);
    // Do not keep the event loop alive solely for the log timer.
    (this.logTimer as { unref?: () => void }).unref?.();
  }

  private stopLogTimer(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
  }

  /** Ship buffered logs (best-effort; never throws into the execution path). */
  private async flushLogs(): Promise<void> {
    if (this.logBuffer.length === 0) return;
    const logs = this.logBuffer;
    this.logBuffer = [];
    try {
      await this.kernel.appendLogs(this.run.id, logs);
    } catch (err) {
      // best-effort: logs are not critical, drop on failure — but say how many
      // lines went missing, or a run detail page silently short of its logs
      // reads as a task that never logged.
      const d = this.diagnostics;
      if (d) {
        d.counters.logFlushErrors += 1;
        d.log.warn(
          `log-flush:${errorKey(err)}`,
          `dropped ${logs.length} log line(s) for run ${this.run.id} (task=${this.run.taskId})`,
          err,
        );
      }
    }
  }
}
