/* =============================================================================
   @better-trigger/example-basic — replay-drift task module, DEPLOY #2.

   The "after" side of the mid-flight redeploy: same task ids, same wait, but a
   ctx.step("audit") is INSERTED between "load" and the wait. Nothing about the
   edit looks dangerous in review — and it is exactly the edit that corrupts
   every in-flight ledger, because replay keys steps by position:

     seq | ledger written by v1 | call site in v2
     ----+----------------------+------------------
       0 | step  "load"         | step "load"        ← still agrees
       1 | wait                 | step "audit"       ← DRIFT (kind mismatch)
       2 | (never reached)      | wait
       3 | (never reached)      | step "finish"

   At seq 1 the v2 code asks for a step and finds a wait row — a kind drift
   that is refused in BOTH replay modes:
     - drift-strict  (replay:'strict')  → AbortError, run fails, nothing lies.
     - drift-lenient (default)          → ALSO a non-retryable AbortError,
       attempt stays 1. The step body NEVER executes (no marker line) and the
       run fails instead of reporting success.

   Env (set by replay-drift.ts): BT_MARKER_FILE, BT_DRIFT_WAIT.
   ============================================================================= */
import { appendFileSync } from 'node:fs';
import { task, type RunCtx } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('replay-drift-tasks-v2: BT_MARKER_FILE is required');
const waitFor = process.env.BT_DRIFT_WAIT ?? '6s';

/** Shared v2 body — v1's, plus one inserted step before the wait. */
const v2Body = (mode: string) => async (payload: { user: string }, ctx: RunCtx) => {
  const loaded = await ctx.step('load', () => {
    appendFileSync(markerFile, `load:${mode}\n`);
    return { user: payload.user };
  });

  // seq 1 — THE INSERTION. v1's ledger has the wait row here.
  const audit = await ctx.step('audit', () => {
    appendFileSync(markerFile, `audit:${mode}\n`);
    return { audited: true };
  });

  await ctx.wait.for(waitFor);

  const done = await ctx.step('finish', () => {
    appendFileSync(markerFile, `finish:${mode}\n`);
    return { sentTo: loaded.user };
  });

  return { deploy: 'v2', mode, audit, ...done };
};

export const driftStrict = task({
  id: 'drift-strict',
  replay: 'strict',
  run: v2Body('strict'),
});

export const driftLenient = task({
  id: 'drift-lenient',
  run: v2Body('lenient'),
});

export const allTasks = [driftStrict, driftLenient];
