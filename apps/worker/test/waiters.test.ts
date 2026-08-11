/* =============================================================================
   @better-trigger/worker — in-process waiter registry (PF2,
   todos/02-performance.md) and the claim-wake primitives.

   The registry replaces N independent kernel waitForResult poll loops with one
   shared structure: N waiters share a single 1s sweep (`WHERE id = ANY(...)`)
   plus terminal notifications, instead of ~4 SELECT/s per waiter. Its
   correctness contract mirrors kernel.waitForResult exactly:

     - run already terminal at register() → resolved immediately (this is also
       the race guard against a notification that fired before the waiter);
     - terminal notification (registry.resolve) → settled with output/error;
     - deadline passed → settled with the latest non-terminal status;
     - run vanished → rejected not_found.

   No Postgres: the registry takes a Pool, so a fake pool that answers the two
   query shapes (single-run read, batch ANY read) is enough.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { createNotifyCounters } from '../src/observability';
import { createWakeSignal, sleepWithWake } from '../src/notify';
import { createWaiterRegistry, type WaiterRegistry } from '../src/waiters';

interface FakeRun {
  id: string;
  status: string;
  output?: unknown;
  error?: unknown;
}

/** Fake pool: holds the runs table in memory, counts reads on `runs`. */
function fakePool() {
  const runs = new Map<string, FakeRun>();
  let selects = 0;
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/FROM runs/.test(text)) selects += 1;
      if (/WHERE id = \$1/.test(text)) {
        const row = runs.get(String(params?.[0]));
        return {
          rows: row
            ? [{ status: row.status, output: row.output ?? null, error: row.error ?? null }]
            : [],
        };
      }
      if (/WHERE id = ANY\(\$1::text\[\]\)/.test(text)) {
        const ids = params?.[0] as string[];
        return {
          rows: ids
            .map((id) => runs.get(id))
            .filter((r): r is FakeRun => r !== undefined)
            .map((r) => ({
              id: r.id,
              status: r.status,
              output: r.output ?? null,
              error: r.error ?? null,
            })),
        };
      }
      return { rows: [] };
    },
  };
  return {
    pool: pool as Parameters<typeof createWaiterRegistry>[0]['pool'],
    runs,
    selects: () => selects,
  };
}

function registry(pollMs = 20): { reg: WaiterRegistry; runs: Map<string, FakeRun>; selects: () => number } {
  const f = fakePool();
  const reg = createWaiterRegistry({ pool: f.pool, counters: createNotifyCounters(), pollMs });
  return { reg, runs: f.runs, selects: f.selects };
}

const NS = DEFAULT_NAMESPACE;

describe('waiter registry', () => {
  it('resolves immediately when the run is already terminal', async () => {
    const { reg, runs } = registry();
    runs.set('run_done', { id: 'run_done', status: 'completed', output: { ok: 1 } });
    const res = await reg.register('run_done', NS, { timeoutMs: 5_000 });
    expect(res).toEqual({ status: 'completed', output: { ok: 1 }, error: undefined });
    reg.stop();
  });

  it('rejects not_found when the run does not exist', async () => {
    const { reg } = registry();
    await expect(reg.register('run_ghost', NS, { timeoutMs: 5_000 })).rejects.toThrow(KernelError);
    reg.stop();
  });

  it('a terminal notification settles every waiter of that run with output/error', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_a', { id: 'run_a', status: 'running' });
    const pa = reg.register('run_a', NS, { timeoutMs: 5_000 });
    const pb = reg.register('run_a', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5)); // let both registrations land
    expect(reg.pending()).toBe(2);
    // Between registration and the notification: no sweep may resolve them yet.
    expect(selects()).toBe(2); // two initial reads only

    runs.set('run_a', { id: 'run_a', status: 'failed', error: { message: 'boom' } });
    await reg.resolve('run_a');
    const [a, b] = await Promise.all([pa, pb]);
    expect(a).toEqual({ status: 'failed', error: { message: 'boom' }, output: undefined });
    expect(b).toEqual(a);
    expect(reg.pending()).toBe(0);
    // One batched sweep would still not have run: N waiters, N+1 reads total.
    expect(selects()).toBe(3);
    reg.stop();
  });

  it('a stale terminal notification (run still non-terminal) settles nothing', async () => {
    const { reg, runs } = registry();
    runs.set('run_s', { id: 'run_s', status: 'running' });
    const p = reg.register('run_s', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    await reg.resolve('run_s'); // row still running → stale
    expect(reg.pending()).toBe(1);
    runs.set('run_s', { id: 'run_s', status: 'completed', output: 42 });
    const res = await p; // the sweep picks it up
    expect(res.status).toBe('completed');
    reg.stop();
  });

  it('the shared poller batches N waiters into ONE query and settles them', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_x', { id: 'run_x', status: 'running' });
    const waiters = Array.from({ length: 5 }, () => reg.register('run_x', NS, { timeoutMs: 5_000 }));
    const before = selects();
    await new Promise((r) => setTimeout(r, 60)); // let ≥2 sweeps run
    expect(selects() - before).toBeLessThanOrEqual(4); // ~1 query per sweep, not 5
    runs.set('run_x', { id: 'run_x', status: 'completed', output: 'done' });
    const results = await Promise.all(waiters);
    for (const r of results) expect(r.status).toBe('completed');
    reg.stop();
  });

  it('times out with the latest non-terminal status, matching waitForResult', async () => {
    const { reg, runs } = registry();
    runs.set('run_t', { id: 'run_t', status: 'running' });
    const res = await reg.register('run_t', NS, { timeoutMs: 40 });
    expect(res).toEqual({ status: 'running' });
    reg.stop();
  });

  it('a run that vanishes after registration rejects not_found', async () => {
    const { reg, runs } = registry();
    runs.set('run_v', { id: 'run_v', status: 'running' });
    const p = reg.register('run_v', NS, { timeoutMs: 5_000 });
    runs.delete('run_v'); // pruned
    await expect(p).rejects.toThrow(KernelError);
    reg.stop();
  });

  it('stop() settles every pending waiter and the poller stops querying', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_z', { id: 'run_z', status: 'running' });
    const p = reg.register('run_z', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    expect(reg.pending()).toBe(1);

    reg.stop();
    // The pending waiter must not hang: it is rejected with the shutdown error
    // — never resolved with a fabricated status.
    await expect(p).rejects.toThrow('daemon shutting down');
    expect(reg.pending()).toBe(0);

    // And the poll timer must be dead: no sweep queries after stop().
    const before = selects();
    await new Promise((r) => setTimeout(r, 70)); // ~3 poll intervals
    expect(selects()).toBe(before);
    reg.stop(); // idempotent
  });

  it('register() after stop() refuses immediately, without touching the DB', async () => {
    const { reg, runs, selects } = registry();
    reg.stop();
    runs.set('run_y', { id: 'run_y', status: 'completed' });
    await expect(reg.register('run_y', NS, { timeoutMs: 1_000 })).rejects.toThrow(
      'daemon shutting down',
    );
    expect(selects()).toBe(0); // refused before the initial read
  });
});

describe('claim wake primitives', () => {
  it('a wake signal resolves an idle sleep immediately', async () => {
    const wake = createWakeSignal();
    const t0 = Date.now();
    const sleep = sleepWithWake(10_000, wake);
    setTimeout(() => wake.emit(), 20);
    await sleep;
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('without a wake signal it is a plain sleep', async () => {
    const t0 = Date.now();
    await sleepWithWake(30, null);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('an unsubscribed listener no longer wakes future sleeps', async () => {
    const wake = createWakeSignal();
    const off = wake.subscribe(() => {});
    off();
    let fired = 0;
    wake.subscribe(() => {
      fired += 1;
    });
    wake.emit();
    expect(fired).toBe(1);
  });
});
