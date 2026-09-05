import type { RunStatus } from './types';

/**
 * The result wait budget expired before a terminal state was observed.
 * `status` is the latest observation, or undefined if no read succeeded.
 * Shared by the SDK, kernel and worker so instanceof works across transports.
 */
export class ResultTimeoutError extends Error {
  readonly status: RunStatus | undefined;
  constructor(runId: string, timeoutMs: number, status: RunStatus | undefined) {
    super(
      `run ${runId} did not reach a terminal state within ${timeoutMs}ms` +
        (status !== undefined ? ` (status ${status})` : ''),
    );
    this.name = 'ResultTimeoutError';
    this.status = status;
  }
}
