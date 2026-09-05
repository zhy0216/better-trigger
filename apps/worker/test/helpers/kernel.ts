import type { Namespace } from '@better-trigger/core';
import { createOrchestratorCounters, type Kernel } from '@better-trigger/kernel';
import { expect, vi } from 'vitest';
import type { WorkerLogger } from '../../src/observability';
import type { WorkerHandle } from '../../src/runtime';

type ExecutionMethods = Pick<Kernel, 'claimRuns'> & Partial<Pick<Kernel,
  'heartbeat' | 'reportStep' | 'completeRun' | 'failRun' | 'suspendRun' | 'appendLogs'
>>;

type RuntimeKernel = ExecutionMethods & Pick<Kernel,
  'registerWorker' | 'startOrchestrator' | 'heartbeat' | 'releaseClaims' | 'deregisterWorker'
>;

/** Shared only by the outcome, heartbeat-cancel and crash-context fixtures. */
export function runtimeTestKernel(
  methods: ExecutionMethods,
  { workerId = 'w1', releasedRunIds = [] }: { workerId?: string; releasedRunIds?: string[] } = {},
) {
  const releaseClaims = vi.fn<Kernel['releaseClaims']>(async () => ({ releasedRunIds }));
  const deregisterWorker = vi.fn<Kernel['deregisterWorker']>(async () => {});
  const stopOrchestrator = vi.fn<() => void>();
  const logger = {
    warn: vi.fn<WorkerLogger['warn']>(),
    error: vi.fn<WorkerLogger['error']>(),
  };
  const kernel: RuntimeKernel = {
    registerWorker: async () => ({ workerId }),
    startOrchestrator: () => ({ stop: stopOrchestrator, counters: createOrchestratorCounters() }),
    heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    releaseClaims,
    deregisterWorker,
    ...methods,
  };

  return {
    // These tests only exercise the runtime and the executor methods supplied
    // above. Keep the assertion at this boundary; every stub is checked against
    // Kernel, and the entire runtime lifecycle is required by RuntimeKernel.
    kernel: kernel as Kernel,
    logger,
    expectStopped(handle: WorkerHandle, namespaces: readonly Namespace[]) {
      expect(handle.inFlightRunIds()).toEqual([]);
      expect(stopOrchestrator).toHaveBeenCalledExactlyOnceWith();
      expect(releaseClaims).toHaveBeenCalledExactlyOnceWith({ workerId: handle.workerId, namespaces });
      expect(deregisterWorker).toHaveBeenCalledExactlyOnceWith({ workerId: handle.workerId });
      // Returning claims emits an informational warning. Any shutdown failure
      // would add a warning here, even though stop() itself still resolves.
      expect(logger.warn.mock.calls).toEqual(releasedRunIds.length === 0 ? [] : [[
        `[better-trigger] released ${releasedRunIds.length} claim(s) on shutdown ` +
          `(worker=${handle.workerId}): ${releasedRunIds.join(', ')}`,
      ]]);
      expect(logger.error).not.toHaveBeenCalled();
    },
  };
}
