/* =============================================================================
   @better-trigger/example-basic — notification fast-path task module (PF2).

   Loaded by the executor daemon scripts/notify.ts spawns:
     better-trigger-worker --tasks scripts/notify-tasks.ts

   Three tasks, one per acceptance check:

     notify-fast    returns immediately — the claim-wake latency probe (its
                    trigger must be claimed without waiting out the idle
                    backoff);
     notify-slow    parks ~1.5s inside a step — the parallel-result() waiter
                    probe (8 concurrent waiters must all resolve at terminal,
                    not at their 3s timeout);
     notify-marker  appends to $BT_MARKER_FILE inside its step — the
                    duplicate-notification exactly-once probe (N duplicate
                    notifications must not make the step run twice).

   Env (set by notify.ts): BT_MARKER_FILE.
   ============================================================================= */
import { appendFileSync } from 'node:fs';
import { task } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('notify-tasks: BT_MARKER_FILE is required');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const notifyFast = task({
  id: 'notify-fast',
  run: async (payload: { v?: number }, ctx) => {
    await ctx.step('work', () => payload.v ?? 1);
    return 'fast-done';
  },
});

export const notifySlow = task({
  id: 'notify-slow',
  run: async (payload: { waitMs?: number }, ctx) => {
    await ctx.step('work', async () => {
      await sleep(payload.waitMs ?? 1_500);
      return 'slow-done';
    });
    return 'slow-done';
  },
});

export const notifyMarker = task({
  id: 'notify-marker',
  run: async (payload: { v?: number }, ctx) => {
    await ctx.step('work', () => {
      appendFileSync(markerFile, 'ran\n');
      return payload.v ?? 1;
    });
    return 'marker-done';
  },
});
