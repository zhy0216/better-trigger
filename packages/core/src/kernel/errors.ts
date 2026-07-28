/* =============================================================================
   @better-trigger/core — kernel error types.
   Transport-neutral domain errors raised by kernel operations. Hosts that
   expose the kernel over HTTP map codes to statuses (run_not_running /
   stale_lease / conflict → 409, not_found / task_not_found → 404,
   bad_request → 400, anything else → 500).
   ============================================================================= */

export type KernelErrorCode =
  | 'not_found'
  | 'run_not_running'
  | 'stale_lease'
  | 'task_not_found'
  | 'bad_request'
  | 'conflict';

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
