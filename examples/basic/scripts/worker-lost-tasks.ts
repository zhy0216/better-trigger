/* =============================================================================
   @better-trigger/example-basic — worker-lost task module.

   Loaded by the executor daemon worker-lost.ts spawns:
     better-trigger-worker --tasks scripts/worker-lost-tasks.ts --no-serve

     wl-parent — triggerAndWaits wl-child and returns { ok, childRunId, error }
                 WITHOUT unwrapping, so a lost child completes the parent with
                 ok:false instead of failing it.
     wl-child  — retry { maxAttempts: 1 }; sleeps 60s so the harness can
                 SIGKILL the daemon while the child is mid-run — twice. The
                 first lost worker must cost a `recovery`, NOT the child's only
                 attempt (C4): losing a machine is not the task failing. The
                 second exhausts the recovery budget the scenario stamps
                 (BETTER_TRIGGER_MAX_RECOVERIES=1), so the reaper must
                 terminal-fail the child as 'worker lost' and wake the waiting
                 parent.
   ============================================================================= */
import { task } from 'better-trigger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const wlChild = task({
  id: 'wl-child',
  retry: { maxAttempts: 1 },
  run: async (_payload: { note: string }) => {
    await sleep(60_000); // SIGKILL window — the child must never finish on its own
    return 'unreachable';
  },
});

export const wlParent = task({
  id: 'wl-parent',
  run: async (payload: { note: string }) => {
    const result = await wlChild.triggerAndWait({ note: payload.note });
    return { ok: result.ok, childRunId: result.id, error: result.error ?? null };
  },
});
