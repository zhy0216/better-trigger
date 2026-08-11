/* =============================================================================
   @better-trigger/example-basic — run-detail pagination task module (PF3).

   Loaded by the executor daemon scripts/run-detail.ts spawns:

     log-storm  emits 1199 info lines then ONE error-level line (the 1200th)
                and fails. That is the PF3 fixture: with the OLD detail read
                the first 1000 lines were shown and the run's final error was
                cut off; the new read must show the newest 200 lines by
                default — including that error line — and page back to the
                first line via the id cursor.

   The loop paces itself on purpose: the executor flushes its log buffer
   asynchronously at 50 lines, and a synchronous 1200-iteration loop would fire
   ~24 flushes whose INSERTs race (out-of-order ids, and rows that land after
   the run's terminal UPDATE are dropped by the appendLogs finished_at guard).
   Sleeping 10ms per 50 lines lets each flush complete before the next batch,
   so the log ids are exactly line+1 — which is what makes "1200 lines in 6
   pages of 200" assertable.
   ============================================================================= */
import { task, AbortError } from 'better-trigger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const logStorm = task({
  id: 'log-storm',
  run: async (_payload: Record<string, never>, ctx) => {
    for (let i = 0; i < 1199; i++) {
      ctx.logger.info(`line ${i}`);
      if ((i + 1) % 50 === 0) await sleep(10);
    }
    // The 1200th and last line is the run's final error — what the default
    // detail page must not hide.
    ctx.logger.error('final error', { detail: 'boom' });
    // Let the final in-flight flush land before the run goes terminal, or the
    // last lines would race the failure and be dropped.
    await sleep(50);
    // AbortError (like the example's always-aborts): no retry, so the run has
    // exactly one attempt and exactly 1200 log lines.
    throw new AbortError('final boom');
  },
});

export const longRun = task({
  id: 'long-run',
  run: async (_payload: Record<string, never>, ctx) => {
    // 60 fast lines (one 50-line flush lands ~10ms in) then ~1.5s of silence:
    // long enough for the scenario to read live detail snapshots while the
    // run is still 'running'.
    for (let i = 0; i < 60; i++) {
      ctx.logger.info(`live ${i}`);
      if ((i + 1) % 50 === 0) await sleep(10);
    }
    for (let i = 0; i < 15; i++) await sleep(100);
    return 'done';
  },
});
