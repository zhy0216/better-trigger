/* =============================================================================
   better-trigger — replay executor (the core of the runtime).
   Implements docs/backend-contract.md §3.1–§3.4 and §3.8.

   One Executor instance drives a single execution of a task's run() function:
     - a monotonic seq counter is consumed by every durable primitive;
     - a snapshot Map<seq, StepSnapshot> short-circuits completed steps;
     - failures are reported and the execution ends via an internal signal;
     - waits / triggerAndWait suspend by throwing SuspendSignal (caught here).

   Every kernel write carries this claim's { workerId, fencingToken }; a
   run_not_running / stale_lease rejection means the run moved on without us
   and the executor abandons silently (the old HTTP-409 path).

   The executor is stored in AsyncLocalStorage so handles created elsewhere can
   detect "am I inside a run?" and become durable steps.
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
  type Kernel,
  type LogEntry,
  type RetryPolicy,
  type StepKind,
  type StepSnapshot,
  type TaskRunResult,
  type TriggerItem,
  type TriggerOptions,
} from '@better-trigger/core';
import { executorStorage, type RunCtx, type RunInfo, type StepOptions } from './context';

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

/** Minimal task shape the executor needs (avoids a circular import on TaskHandle). */
export interface ExecutorTask {
  id: string;
  retry?: RetryPolicy;
  run: (payload: any, ctx: RunCtx) => unknown | Promise<unknown>;
  /** Validate/parse the raw payload; throws SchemaValidationError on bad input. */
  validate?: (payload: unknown) => Promise<unknown> | unknown;
}

/** Outcome of a single execution pass. */
export type ExecutionResult =
  | { type: 'completed'; output: unknown }
  | { type: 'failed' }
  | { type: 'suspended' }
  | { type: 'abandoned' }; // run no longer running / lease lost — give up silently

const LOG_FLUSH_INTERVAL_MS = 1_000;
const LOG_FLUSH_THRESHOLD = 50;

export class Executor {
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
    if (err instanceof ExecutionDone || (err as any)?.isBetterTriggerExecutionDone) {
      return { type: 'failed' };
    }
    if (this.abandoned) return { type: 'abandoned' };
    // Error thrown between steps (not inside ctx.step): fail the run, no stepSeq.
    const abort = isAbortError(err);
    await this.failRun(serializeError(err), undefined, abort, undefined);
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
      now: () => this.doDeterministic('now'),
      random: () => this.doDeterministic('random'),
      uuid: () => this.doDeterministic('uuid'),
    };
  }

  /* ---- seq + snapshot helpers ------------------------------------------ */

  private nextSeq(): number {
    return this.seq++;
  }

  /** A snapshot row counts as a cache hit only if it completed. */
  private cached(seq: number, expectedLabel: string | null): StepSnapshot | undefined {
    const snap = this.snapshot.get(seq);
    if (!snap || snap.status !== 'completed') return undefined;
    if (expectedLabel != null && snap.label != null && snap.label !== expectedLabel) {
      // Soft drift: label changed but position matched. Warn, do not fail.
      this.log('warn', `step label drift at seq ${seq}: "${snap.label}" → "${expectedLabel}"`);
    }
    return snap;
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

    const hit = this.cached(seq, label);
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

    if (this.cached(seq, null)) return; // already resumed on a prior replay
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

    const hit = this.cached(seq, label);
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

    const hit = this.cached(seq, label);
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

    const hit = this.cached(seq, null);
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
