/* =============================================================================
   @better-trigger/example-basic — loop-hang task module.

   The single task the loop-hang scenario's daemon registers. The scenario
   seeds one 'waiting' run against it by hand and lets the wait-due scanner
   resume it; the scanner's resume is the statement under test (see
   loop-hang.ts), so the task body itself is deliberately trivial — it exists
   so the daemon runs the waits orchestrator loop at all (a --tasks daemon
   runs it; a bookkeeping-only one does not), and so a resumed run can be
   claimed and completed end-to-end.
   ============================================================================= */
import { task } from 'better-trigger';

/** The task id loop-hang.ts seeds its waiting run with. */
export const LOOP_HANG_TASK_ID = 'loop-hang-probe';

export const loopHang = task({
  id: LOOP_HANG_TASK_ID,
  run: async () => ({ ok: true }),
});
