/* =============================================================================
   @better-trigger/example-basic — crash-recovery worker (spawned by crash.ts).

   Runs a single 'crash-test' task designed to be SIGKILLed mid-flight:

     step1 (append "step1" to $BT_MARKER_FILE)
       → pure sleep 4s            (kill window #1 / #3 — NOT a durable step)
       → wait.for("2s")           (suspend → status 'waiting' — kill window #2)
       → pure sleep 4s
       → step2 (append "step2")
       → return the payload (echo)

   The marker file is the exactly-once probe: durable steps must run once
   across every crash/reclaim, while the pure sleeps re-execute on each
   attempt. Short lease (3s) + fast reaper (500ms) make recovery quick.

   Env (set by crash.ts): DATABASE_URL, BT_MARKER_FILE.
   ============================================================================= */
import { appendFileSync } from 'node:fs';
import { betterTrigger, task } from 'better-trigger';

const markerFile = process.env.BT_MARKER_FILE;
if (!markerFile) throw new Error('crash-worker: BT_MARKER_FILE is required');
if (!process.env.DATABASE_URL) throw new Error('crash-worker: DATABASE_URL is required');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const crashTest = task({
  id: 'crash-test',
  retry: { maxAttempts: 5 },
  run: async (payload: { note: string }, ctx) => {
    await ctx.step('step1', () => {
      appendFileSync(markerFile, 'step1\n');
      return 'step1-done';
    });

    await sleep(4_000); // kill window: lease keeps renewing until SIGKILL

    await ctx.wait.for('2s'); // suspend → 'waiting' (second kill window)

    await sleep(4_000); // kill window after resume

    await ctx.step('step2', () => {
      appendFileSync(markerFile, 'step2\n');
      return 'step2-done';
    });

    return payload;
  },
});

const trigger = betterTrigger({
  database: { connectionString: process.env.DATABASE_URL },
  orchestrator: { reaperIntervalMs: 500 },
});

const worker = await trigger.start({
  tasks: [crashTest],
  concurrency: 1,
  leaseMs: 3_000,
});

console.log(`[crash-worker] started as ${worker.workerId} (pid ${process.pid})`);
await worker.done;
