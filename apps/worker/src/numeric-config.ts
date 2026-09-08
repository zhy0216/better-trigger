import type { OrchestratorOptions } from '@better-trigger/kernel';

/** Largest single setTimeout/setInterval delay; larger delays can become 1ms. */
export const MAX_TIMER_MS = 2_147_483_647;
export const MIN_HEARTBEAT_MS = 500;
/** Below three heartbeat floors a live claim can expire before renewal. */
export const MIN_LEASE_MS = 3 * MIN_HEARTBEAT_MS;

// floor(leaseMs / 3) must fit one timer, including the final two remainder ms.
// This ~75-day bound is tighter than JS Date and PostgreSQL timestamp/interval
// storage bounds: the lease is persisted as now() + '<leaseMs> milliseconds'.
// It is NOT a cap on durable waits or retention windows.
export const MAX_LEASE_MS = 3 * MAX_TIMER_MS + 2;

export function requireTimerMs(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive integer between 1 and ${MAX_TIMER_MS} milliseconds`);
  }
  return value;
}

/** Validate before registration, migrations, pool creation or background loops. */
export function requireLeaseMsValue(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS) {
    throw new RangeError(
      `${name} must be an integer of at least ${MIN_LEASE_MS} within the safe integer range ` +
        `(the heartbeat renews at most every ${MIN_HEARTBEAT_MS}ms; a shorter lease expires before its first renewal)`,
    );
  }
  if (value > MAX_LEASE_MS) {
    throw new RangeError(
      `${name} must be at most ${MAX_LEASE_MS} milliseconds so its heartbeat interval fits ${MAX_TIMER_MS} milliseconds`,
    );
  }
  return value;
}

// Host preflight mirrors the kernel's direct-entry guard. Keep this package
// local: the worker must reject before registering, and embedded before even
// creating a pool, while the kernel also supports callers without a worker.
export function validateOrchestratorTimers(opts: OrchestratorOptions = {}): void {
  for (const name of [
    'timerIntervalMs', 'cronIntervalMs', 'reaperIntervalMs', 'gcIntervalMs', 'strandedIntervalMs',
  ] as const) {
    const value = opts[name];
    if (value !== undefined) requireTimerMs(name, value);
  }
}
