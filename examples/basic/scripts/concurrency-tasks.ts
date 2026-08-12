/* =============================================================================
   @better-trigger/example-basic — concurrency-limit task module.

   Loaded by the executor daemons concurrency.ts spawns:
     better-trigger-worker --tasks scripts/concurrency-tasks.ts --no-serve

     cc-limited — `concurrency: { limit, key }`: at most CC_LIMIT runs sharing a
                  key may be 'running' at once, however many execution slots the
                  daemons offer. The body only holds its slot for `holdMs`, so
                  the harness has a window wide enough to watch runs overlap;
                  the payload's `group` is the concurrency key, so one task id
                  covers both halves of the property (a key is capped, and two
                  keys do not cap each other).

     cc-serial — `concurrency: { limit: 1, key }`: the serialized-backlog twin of
                  cc-limited. One run of a key is allowed at a time, and the body
                  is a fast step, so a queued chain advances as fast as the
                  engine can hand a slot off. That hand-off latency is what the
                  latency assertion (todos/p1-10) measures: each terminal run of
                  a key now sends a `work` notification, so run N+1's start must
                  land well inside the idle-poll base (`IDLE_POLL_BASE_MS`, 300ms)
                  of run N's finish instead of at the next poll boundary.

   `retry: { maxAttempts: 1 }` on purpose: a retried run keeps its FIRST
   `started_at` (the claim COALESCEs it), which would silently stretch the
   [started_at, finished_at) window the scenario measures overlap on. With one
   attempt a hiccup fails the run — and the scenario — instead of quietly
   widening the measurement.
   ============================================================================= */
import { task } from 'better-trigger';

/** Runs per key allowed to be 'running' at once. Read by the scenario too. */
export const CC_LIMIT = 2;

/** Cap for the serialized chain (p1-10): one run of a key at a time. */
export const CC_SERIAL_LIMIT = 1;

export interface CcPayload {
  /** Concurrency key: runs sharing a group are capped against each other. */
  group: string;
  /** How long the run occupies its slot. */
  holdMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ccLimited = task({
  id: 'cc-limited',
  retry: { maxAttempts: 1 },
  concurrency: { limit: CC_LIMIT, key: (p: CcPayload) => p.group },
  run: async (payload: CcPayload) => {
    await sleep(payload.holdMs);
    return { group: payload.group };
  },
});

/** The serialized chain used by the p1-10 latency assertion. */
export const ccSerial = task({
  id: 'cc-serial',
  retry: { maxAttempts: 1 },
  concurrency: { limit: CC_SERIAL_LIMIT, key: (p: CcPayload) => p.group },
  run: async (payload: CcPayload) => {
    await sleep(payload.holdMs);
    return { group: payload.group };
  },
});
