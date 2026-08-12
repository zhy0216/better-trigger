/* =============================================================================
   @better-trigger/example-basic — replay-drift rename task module, DEPLOY #1.

   The "before" side of the label-drift fixture. Two tasks with identical
   bodies, differing only in replay strictness:

     rename-strict   replay: 'strict'
     rename-lenient  (default 'lenient')

   Both: step "load" → step "charge" → wait.for(BT_DRIFT_WAIT) → step "finish".

   replay-drift.ts triggers one run of each, lets them suspend on the wait,
   kills this executor, and brings up replay-drift-rename-tasks-v2.ts — which
   renames seq 1's "charge" step to "charge-v2" AND rewrites its body, so the
   replay sees a label drift whose old-label fingerprint no longer matches. Keep
   the "load" step (and the wait declaration) byte-identical with v2: they are
   the agreeing prefix the harness asserts replays from cache.
   ============================================================================= */
import { appendFileSync } from 'node:fs';
import { task, type RunCtx } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('replay-drift-rename-tasks-v1: BT_MARKER_FILE is required');
const waitFor = process.env.BT_DRIFT_WAIT ?? '6s';

/** The v1 "charge" implementation — v2's differs in source, which is the point. */
const chargeV1 = (mode: string) => () => {
  appendFileSync(markerFile, `charge:${mode}\n`);
  return { amount: 100 };
};

/** Shared v1 body, instantiated once per strictness mode. */
const v1Body = (mode: string) => async (payload: { user: string }, ctx: RunCtx) => {
  const loaded = await ctx.step('load', () => {
    appendFileSync(markerFile, `rename-load:${mode}\n`);
    return { user: payload.user };
  });

  // seq 1 — the charge step. v2 renames it to "charge-v2" and rewrites the
  // body, so this call site no longer matches the recorded row.
  const charged = await ctx.step('charge', chargeV1(mode));

  // seq 2 — the wait. v2 keeps it identical, so only seq 1 drifts.
  await ctx.wait.for(waitFor);

  const done = await ctx.step('finish', () => {
    appendFileSync(markerFile, `rename-finish:${mode}\n`);
    return { sentTo: loaded.user, amount: charged.amount };
  });

  return { deploy: 'rename-v1', mode, ...done };
};

export const renameStrict = task({
  id: 'rename-strict',
  replay: 'strict',
  run: v1Body('strict'),
});

export const renameLenient = task({
  id: 'rename-lenient',
  run: v1Body('lenient'),
});

export const allTasks = [renameStrict, renameLenient];
