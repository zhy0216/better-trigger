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
  isSuspendSignal,
  KernelError,
  serializeError,
  SuspendSignal,
  type ClaimedRun,
  type LogEntry,
  type RetryPolicy,
  type StepKind,
  type StepSnapshot,
  type TaskRunResult,
  type TriggerItem,
  type TriggerOptions,
} from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
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

/** Thrown internally to unwind the run() stack after a fatal failure was reported. */
class ExecutionDone extends Error {
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
   * Lease-loss seam for todos/01-correctness.md C2: once the heartbeat response
   * carries lostRunIds, runtime.ts's heartbeat loop calls this for each of them
   * (next to the existing markCanceled() call). Nothing detects lease loss yet,
   * so nothing calls this — deliberately: C2 owns the detection side.
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
      throw new ExecutionDone();
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

      // Normal return → complete.
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
    if (err instanceof ExecutionDone || (err as any)?.isBetterTriggerExecutionDone) {
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

  /* ---- ctx construction ------------------------------------------------ */

  private buildCtx(runInfo: RunInfo): RunCtx {
    return {
      run: runInfo,
      step: (label, fn, opts) => this.doStep(label, fn, opts),
      wait: {
        for: (duration) => this.doWait('duration', durationToDate(duration)),
        until: (date) => this.doWait('until', date),
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
   * Under replay:'strict' either mismatch aborts the run; the default stays
   * lenient (warn + use the row) for backward compatibility.
   */
  private cached(
    seq: number,
    expectedKind: StepKind,
    expectedLabel: string | null,
  ): StepSnapshot | undefined {
    const snap = this.snapshot.get(seq);
    if (!snap || snap.status !== 'completed') return undefined;

    if (snap.kind !== expectedKind) {
      this.onReplayDrift(seq, `kind '${snap.kind}' → '${expectedKind}'`);
    } else if (expectedLabel != null && snap.label != null && snap.label !== expectedLabel) {
      this.onReplayDrift(seq, `label "${snap.label}" → "${expectedLabel}"`);
    }
    return snap;
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
      throw new ExecutionDone();
    }
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
    if (this.abandoned) throw new ExecutionDone();
    this.assertNotNested(`ctx.step("${label}")`);
    const seq = this.nextSeq();

    const hit = this.cached(seq, 'step', label);
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
      await this.onStepError(seq, label, 'step', err, opts?.retry, startedAt);
      // onStepError always reports + throws; unreachable, but satisfies types.
      throw new ExecutionDone();
    }

    await this.reportStep(seq, 'step', label, 'completed', result, startedAt);
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
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (e) {
      if (isAbandonment(e)) {
        this.abandoned = true;
        throw new ExecutionDone();
      }
      // Non-fatal: still try to fail the run below.
    }

    const effectiveRetry = abort ? undefined : (stepRetry ?? this.task.retry);
    await this.failRun(serialized, seq, abort, effectiveRetry);
    throw new ExecutionDone();
  }

  private async reportStep(
    seq: number,
    kind: StepKind,
    label: string | null,
    status: 'completed' | 'failed',
    output: unknown,
    startedAt: string,
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
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw new ExecutionDone();
      }
      throw err;
    }
  }

  /* ---- ctx.wait -------------------------------------------------------- */

  private async doWait(kind: 'duration' | 'until', resumeAt: Date): Promise<void> {
    if (this.abandoned) throw new ExecutionDone();
    this.assertNotNested(`ctx.wait.${kind === 'duration' ? 'for' : 'until'}()`);
    const seq = this.nextSeq();

    if (this.cached(seq, 'wait', null)) return; // already resumed on a prior replay
    this.checkCanceled();

    let resumed: boolean;
    try {
      const res = await this.kernel.suspendRun({
        runId: this.run.id,
        seq,
        kind,
        resumeAt: resumeAt.toISOString(),
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
      resumed = res.resumed;
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw new ExecutionDone();
      }
      throw err;
    }

    if (resumed) return; // resumeAt already past — keep executing, seq consumed
    throw new SuspendSignal(seq);
  }

  /* ---- triggerAndWait (called by a TaskHandle inside a run) ------------- */

  async triggerAndWait<TOutput>(
    taskId: string,
    payload: unknown,
    label: string,
    options?: TriggerOptions,
  ): Promise<TaskRunResult<TOutput>> {
    if (this.abandoned) throw new ExecutionDone();
    this.assertNotNested(`triggerAndWait("${taskId}")`);
    const seq = this.nextSeq();

    const hit = this.cached(seq, 'trigger-and-wait', label);
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
        workerId: this.workerId,
        fencingToken: this.run.fencingToken,
      });
    } catch (err) {
      if (isAbandonment(err)) {
        this.abandoned = true;
        throw new ExecutionDone();
      }
      throw err;
    }
    throw new SuspendSignal(seq);
  }

  /* ---- batch / single trigger inside a run (durable batch-trigger step) - */

  async durableBatchTrigger(
    items: TriggerItem[],
    label: string,
  ): Promise<string[]> {
    if (this.abandoned) throw new ExecutionDone();
    this.assertNotNested(`trigger/batchTrigger (${label})`);
    const seq = this.nextSeq();

    const hit = this.cached(seq, 'batch-trigger', label);
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
        throw new ExecutionDone();
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
    if (this.abandoned) throw new ExecutionDone();
    this.assertNotNested(`ctx.${kind}()`);
    const seq = this.nextSeq();

    const hit = this.cached(seq, kind, null);
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

    await this.reportStep(seq, kind, null, 'completed', stored, startedAt);
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
    } catch {
      // best-effort: logs are not critical, drop on failure
    }
  }
}
