/* =============================================================================
   @better-trigger/core — kernel error types.
   Transport-neutral domain errors raised by kernel operations. Hosts that
   expose the kernel over HTTP map codes to statuses (run_not_running /
   stale_lease / conflict → 409, not_found / task_not_found → 404,
   bad_request / serialization_error → 400, payload_too_large → 413,
   anything else → 500).
   ============================================================================= */

export type KernelErrorCode =
  | 'not_found'
  | 'run_not_running'
  | 'stale_lease'
  | 'task_not_found'
  | 'bad_request'
  /**
   * A value could not be serialized to JSON at all (circular structure,
   * BigInt, top-level undefined/function/symbol) on its way into a jsonb/text
   * column or onto the wire. Raised by safeSerializeJson's callers — the
   * kernel persistence paths and the SDK's local request encoding — so it is
   * never a raw TypeError that reads as a 500 (or as a dead daemon).
   */
  | 'serialization_error'
  /**
   * The request body exceeded the host's cap (BETTER_TRIGGER_BODY_LIMIT), or a
   * payload / output / log value exceeded its serialized-size cap
   * (BETTER_TRIGGER_MAX_PAYLOAD_BYTES and friends). Raised by the HTTP host
   * and by the kernel's capped persistence paths — it lives in this union so
   * clients see one error family: a caller that sends too much gets a
   * KernelError with a stable code, not a bare transport failure.
   */
  | 'payload_too_large'
  | 'conflict'
  /**
   * The host refused the request for hitting a rate limit — per API key or per
   * endpoint — on one of the run-affecting routes (trigger / batch-trigger /
   * retry / cancel), HTTP 429. Raised by the worker's rate-limit middleware;
   * it lives in this union so clients see the same KernelError family with a
   * stable code instead of a bare transport failure.
   */
  | 'rate_limited';

export class KernelError extends Error {
  constructor(
    public readonly code: KernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}

/** The run is not in 'running' state (canceled / requeued / terminal). */
export class RunNotRunningError extends KernelError {
  constructor(message: string) {
    super('run_not_running', message);
    this.name = 'RunNotRunningError';
  }
}

/** The caller's fencing token / ownership is stale (run was reclaimed). */
export class StaleLeaseError extends KernelError {
  constructor(message: string) {
    super('stale_lease', message);
    this.name = 'StaleLeaseError';
  }
}

/** The referenced task id is not registered. */
export class TaskNotFoundError extends KernelError {
  constructor(message: string) {
    super('task_not_found', message);
    this.name = 'TaskNotFoundError';
  }
}
