/* =============================================================================
   @better-trigger/kernel — waitForResult poll-interval guard (P2 boundary).

   The HTTP route clamps pollMs to [50, 5000] with onInvalid:'clamp', but
   waitForResult is also the embedded-host path and a public Kernel method —
   a `pollMs: 0` there turns sleep() into a zero-delay timer and the whole
   timeout window into a tight SELECT loop against the database. Same family
   as detailLimit/logsBefore: garbage is refused with bad_request before a
   single query runs, while the normal long-poll behaviour is untouched.

   No Postgres: a stub pool answers the run-status SELECT and counts it.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { waitForResult } from '../src/runs';

/** A pool whose every query proves validation let the call through. */
const sentinel = new Error('query() reached — validation did not refuse');
const refusingPool = {
  query: async () => {
    throw sentinel;
  },
} as unknown as Pool;

const wait = (pool: Pool, opts: { pollMs?: number; timeoutMs?: number } = {}) =>
  waitForResult(pool, 'run_1', DEFAULT_NAMESPACE, opts);

describe('waitForResult pollMs validation', () => {
  it('refuses 0 / negative / fractional below 1 / NaN / Infinity before querying', async () => {
    for (const pollMs of [0, -1, 0.5, NaN, Infinity]) {
      await expect(wait(refusingPool, { pollMs })).rejects.toBeInstanceOf(KernelError);
      await wait(refusingPool, { pollMs }).catch((err: KernelError) => {
        expect(err.code).toBe('bad_request');
        expect(err.message).toMatch(/pollMs/);
      });
    }
  });

  it('keeps the default and explicit legal poll intervals', async () => {
    const queries: unknown[][] = [];
    const donePool = {
      query: async (_sql: string, params: unknown[] = []) => {
        queries.push(params);
        return { rows: [{ status: 'completed', output: { ok: 1 }, error: null }] };
      },
    } as unknown as Pool;

    // Default (no opts) → one query, terminal result on the spot.
    await expect(wait(donePool)).resolves.toEqual({
      status: 'completed',
      output: { ok: 1 },
      error: undefined,
    });
    // The historical floor of the route clamp still passes.
    await expect(wait(donePool, { pollMs: 50 })).resolves.toMatchObject({ status: 'completed' });
    // 1 is the accepted minimum (the old loop would have hammered the DB).
    await expect(wait(donePool, { pollMs: 1 })).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('waitForResult long-poll behaviour (unchanged)', () => {
  it('returns the latest non-terminal status when the timeout window closes', async () => {
    let polls = 0;
    const pool = {
      query: async () => {
        polls += 1;
        return { rows: [{ status: 'running', output: null, error: null }] };
      },
    } as unknown as Pool;

    const before = Date.now();
    const res = await waitForResult(pool, 'run_1', DEFAULT_NAMESPACE, {
      timeoutMs: 60,
      pollMs: 15,
    });
    const elapsed = Date.now() - before;

    expect(res).toEqual({ status: 'running' });
    // A real polling loop: more than one read, and no tighter than pollMs
    // (a 60ms window at 15ms is ≥ 2 polls — proof the sleep still sleeps).
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });
});
