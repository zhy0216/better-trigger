/* =============================================================================
   @better-trigger/example-basic — graceful-restart task module.

   Loaded by the executor daemons graceful-restart.ts spawns:
     better-trigger-worker --tasks scripts/graceful-restart-tasks.ts --no-serve

   A single 'gr-restart' task shaped to be caught mid-flight by a SIGTERM:

     step1 (append "step1")
       → append "pass"          (NOT a durable step — one line per attempt)
       → first pass only: park on ctx.signal  ← the SIGTERM window
       → step2 (append "step2")
       → return the payload (echo)

   `maxAttempts: 1` is the assertion, not a detail: a clean restart must not
   spend a retry, so a run whose attempt gets bumped anywhere on this path has
   no budget left and the next failure ends it — the scenario reads the counter
   directly rather than waiting for that to show up.

   The park is `ctx.signal`-aware so the draining daemon unwinds at once rather
   than sitting out its 30s window; the pass counter is what lets the SECOND
   executor run the same code straight through to step2.

   Env (set by graceful-restart.ts): BT_MARKER_FILE.
   ============================================================================= */
import { appendFileSync, readFileSync } from 'node:fs';
import { task } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('graceful-restart-tasks: BT_MARKER_FILE is required');

const countLines = (name: string): number =>
  readFileSync(markerFile, 'utf8')
    .split('\n')
    .filter((l) => l === name).length;

export const grRestart = task({
  id: 'gr-restart',
  retry: { maxAttempts: 1 },
  run: async (payload: { note: string }, ctx) => {
    await ctx.step('step1', () => {
      appendFileSync(markerFile, 'step1\n');
      return 'step1-done';
    });

    // Pure, so it re-executes on every claim: line count = passes through the
    // body, which is how this task knows whether it is the one being killed.
    appendFileSync(markerFile, 'pass\n');

    if (countLines('pass') === 1) {
      // Executor #1: hold the claim open until the daemon starts draining.
      await new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    }

    await ctx.step('step2', () => {
      appendFileSync(markerFile, 'step2\n');
      return 'step2-done';
    });

    return payload;
  },
});
