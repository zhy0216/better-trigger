/* =============================================================================
   @better-trigger/example-basic — worker-lost worker (spawned by worker-lost.ts).

   Two tasks:

     wl-parent — triggerAndWaits wl-child and returns { ok, childRunId, error }
                 WITHOUT unwrapping, so a lost child completes the parent with
                 ok:false instead of failing it.
     wl-child  — retry { maxAttempts: 1 }; sleeps 60s so the harness can
                 SIGKILL this process while the child is mid-run. With no
                 retry budget left, the reaper must terminal-fail the child as
                 'worker lost' and wake the waiting parent.

   Short lease (3s) + fast reaper (500ms) keep recovery quick.

   Env (set by worker-lost.ts): DATABASE_URL.
   ============================================================================= */
import { betterTrigger, task } from 'better-trigger';

if (!process.env.DATABASE_URL) throw new Error('worker-lost-worker: DATABASE_URL is required');

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

const trigger = betterTrigger({
  database: { connectionString: process.env.DATABASE_URL },
  orchestrator: { reaperIntervalMs: 500 },
});

const worker = await trigger.start({
  tasks: [wlParent, wlChild],
  concurrency: 2,
  leaseMs: 3_000,
});

console.log(`[worker-lost-worker] started as ${worker.workerId} (pid ${process.pid})`);
await worker.done;
