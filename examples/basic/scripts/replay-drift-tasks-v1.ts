/* =============================================================================
   @better-trigger/example-basic — replay-drift task module, DEPLOY #1.

   The "before" side of a mid-flight redeploy. Two tasks with identical bodies,
   differing only in replay strictness:

     drift-strict   replay: 'strict'
     drift-lenient  (default 'lenient')

   Both: step "load" → wait.for(BT_DRIFT_WAIT) → step "finish".

   replay-drift.ts triggers one run of each, lets them suspend on the wait,
   kills this executor, and brings up replay-drift-tasks-v2.ts — which inserts a
   step between "load" and the wait, so seq 1 stops being the wait row. Keep the
   step ids/ordering here in sync with v2; they are the fixture the harness
   asserts against.

   Env (set by replay-drift.ts): BT_MARKER_FILE, BT_DRIFT_WAIT.
   ============================================================================= */
import { appendFileSync } from 'node:fs';
import { task, type RunCtx } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('replay-drift-tasks-v1: BT_MARKER_FILE is required');
const waitFor = process.env.BT_DRIFT_WAIT ?? '6s';

/** Shared v1 body, instantiated once per strictness mode. */
const v1Body = (mode: string) => async (payload: { user: string }, ctx: RunCtx) => {
  const loaded = await ctx.step('load', () => {
    appendFileSync(markerFile, `load:${mode}\n`);
    return { user: payload.user };
  });

  // seq 1 — the wait row. v2 puts a ctx.step() here instead.
  await ctx.wait.for(waitFor);

  const done = await ctx.step('finish', () => {
    appendFileSync(markerFile, `finish:${mode}\n`);
    return { sentTo: loaded.user };
  });

  return { deploy: 'v1', mode, ...done };
};

export const driftStrict = task({
  id: 'drift-strict',
  replay: 'strict',
  run: v1Body('strict'),
});

export const driftLenient = task({
  id: 'drift-lenient',
  run: v1Body('lenient'),
});

export const allTasks = [driftStrict, driftLenient];
