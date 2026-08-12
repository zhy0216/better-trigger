/* =============================================================================
   @better-trigger/example-basic — replay-drift rename task module, DEPLOY #2.

   The "after" side of the label-drift fixture: same task ids, same wait, but
   seq 1's step is renamed "charge" → "charge-v2" AND its body is rewritten.

     seq | ledger written by v1             | call site in v2
     ----+----------------------------------+------------------
       0 | step "load"                      | step "load"        ← still agrees
       1 | step "charge" (chargeV1)         | step "charge-v2"   ← DRIFT (label
       2 | wait                             | wait               ←  + fingerprint)
       3 | (never reached)                  | step "finish"

   At seq 1 the v2 code finds a completed step row whose label differs from
   this call site. Arbitrating with the OLD label's fingerprint (recomputed
   with today's inputs) shows the implementation changed too — the recorded
   output belongs to different code, refused in BOTH replay modes:
     - rename-strict  (replay:'strict')  → AbortError, run fails.
     - rename-lenient (default)          → ALSO a non-retryable AbortError,
       attempt stays 1. A rename PLUS an implementation change is
       unconditional, unlike a pure rename.

   Env (set by replay-drift.ts): BT_MARKER_FILE, BT_DRIFT_WAIT.
   ============================================================================= */
import { appendFileSync } from 'node:fs';
import { task, type RunCtx } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('replay-drift-rename-tasks-v2: BT_MARKER_FILE is required');
const waitFor = process.env.BT_DRIFT_WAIT ?? '6s';

/** The v2 "charge-v2" implementation — renamed, and a DIFFERENT source than
 *  v1's, so the same call site now fingerprints differently. */
const chargeV2 = (mode: string) => () => {
  appendFileSync(markerFile, `charge2:${mode}\n`);
  return { amount: 200, upgraded: true };
};

/** Shared v2 body — v1's, with seq 1's step renamed AND rewritten. */
const v2Body = (mode: string) => async (payload: { user: string }, ctx: RunCtx) => {
  const loaded = await ctx.step('load', () => {
    appendFileSync(markerFile, `rename-load:${mode}\n`);
    return { user: payload.user };
  });

  // seq 1 — THE RENAME + REWRITE. v1's ledger holds step "charge" here.
  const charged = await ctx.step('charge-v2', chargeV2(mode));

  await ctx.wait.for(waitFor);

  const done = await ctx.step('finish', () => {
    appendFileSync(markerFile, `rename-finish:${mode}\n`);
    return { sentTo: loaded.user, amount: charged.amount };
  });

  return { deploy: 'rename-v2', mode, ...done };
};

export const renameStrict = task({
  id: 'rename-strict',
  replay: 'strict',
  run: v2Body('strict'),
});

export const renameLenient = task({
  id: 'rename-lenient',
  run: v2Body('lenient'),
});

export const allTasks = [renameStrict, renameLenient];
