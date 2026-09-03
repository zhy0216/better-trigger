/* =============================================================================
   @better-trigger/testing — invariant assertion unit tests (T5 acceptance).

   The ledger checks are pure logic over `pool.query` rows: a fake pool pins
   the violation and legal-evolution cases without a live Postgres. (The
   acceptance scenarios still exercise them against real tables.)
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createInvariants, type Invariants } from '../src/invariants';

interface FakeState {
  run: Record<string, unknown> | null;
  steps: Record<string, unknown>[];
  queueRows: number;
  pendingWaits: number;
}

function poolFor(state: FakeState): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM run_steps')) return { rows: state.steps };
      if (sql.includes('FROM runs')) return { rows: state.run ? [state.run] : [] };
      if (sql.includes('FROM queue')) return { rows: [{ n: state.queueRows }] };
      if (sql.includes('FROM waits')) return { rows: [{ n: state.pendingWaits }] };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  } as unknown as Pool;
}

const at = (iso: string): Date => new Date(iso);

const stepRow = (seq: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq,
  kind: 'function',
  label: null,
  status: 'completed',
  output: { ok: true },
  error: null,
  attempt: 1,
  started_at: at('2026-01-01T00:00:00Z'),
  finished_at: at('2026-01-01T00:00:01Z'),
  ...over,
});

const completedRun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r1',
  task_id: 't',
  status: 'completed',
  output: { done: true },
  error: null,
  attempt: 1,
  fencing_token: 7,
  finished_at: at('2026-01-01T00:00:02Z'),
  ...over,
});

const invFor = (state: FakeState): Invariants => createInvariants(poolFor(state));

describe('assertSeqContiguous', () => {
  it('accepts a gap-free prefix with matching kinds', async () => {
    const inv = invFor({ run: null, steps: [stepRow(0), stepRow(1)], queueRows: 0, pendingWaits: 0 });
    await inv.assertSeqContiguous('r1', { kinds: ['function', 'function'] });
  });

  it('detects a hole in the seq prefix', async () => {
    const inv = invFor({ run: null, steps: [stepRow(0), stepRow(2)], queueRows: 0, pendingWaits: 0 });
    await expect(inv.assertSeqContiguous('r1')).rejects.toThrow(/gap-free 0\.\.n-1 prefix/);
  });

  it('detects a kinds mismatch', async () => {
    const inv = invFor({ run: null, steps: [stepRow(0)], queueRows: 0, pendingWaits: 0 });
    await expect(inv.assertSeqContiguous('r1', { kinds: ['sleep'] })).rejects.toThrow(
      'step ledger should be [sleep]',
    );
  });
});

describe('assertNoStepRewrites', () => {
  it('detects a completed row being rewritten', async () => {
    const steps = [stepRow(0)];
    const inv = invFor({ run: null, steps, queueRows: 0, pendingWaits: 0 });
    await inv.assertNoStepRewrites('r1');
    steps[0].output = { tampered: true };
    await expect(inv.assertNoStepRewrites('r1')).rejects.toThrow(/completed step row was rewritten/);
  });

  it('detects a failed row regressing to an older attempt (stale write)', async () => {
    const steps = [stepRow(0, { status: 'failed', error: { msg: 'boom' }, attempt: 2 })];
    const inv = invFor({ run: null, steps, queueRows: 0, pendingWaits: 0 });
    await inv.assertNoStepRewrites('r1');
    steps[0].attempt = 1;
    await expect(inv.assertNoStepRewrites('r1')).rejects.toThrow(/moved backwards to attempt 1/);
  });

  it('detects a step row disappearing', async () => {
    const steps = [stepRow(0), stepRow(1)];
    const inv = invFor({ run: null, steps, queueRows: 0, pendingWaits: 0 });
    await inv.assertNoStepRewrites('r1');
    steps.pop();
    await expect(inv.assertNoStepRewrites('r1')).rejects.toThrow(/step row disappeared/);
  });

  it('allows a failed row to be replaced by a later attempt (retry at the same seq)', async () => {
    const steps = [stepRow(0, { status: 'failed', error: { msg: 'boom' }, attempt: 1 })];
    const inv = invFor({ run: null, steps, queueRows: 0, pendingWaits: 0 });
    await inv.assertNoStepRewrites('r1');
    steps[0] = stepRow(0, { attempt: 2 });
    await inv.assertNoStepRewrites('r1');
  });

  it('allows new history to be appended', async () => {
    const steps = [stepRow(0)];
    const inv = invFor({ run: null, steps, queueRows: 0, pendingWaits: 0 });
    await inv.assertNoStepRewrites('r1');
    steps.push(stepRow(1));
    await inv.assertNoStepRewrites('r1');
  });

  it('rejects unsettled rows and rows missing their window', async () => {
    const inv = invFor({
      run: null,
      steps: [stepRow(0, { status: 'running', finished_at: null })],
      queueRows: 0,
      pendingWaits: 0,
    });
    await expect(inv.assertNoStepRewrites('r1')).rejects.toThrow(/unexpected step status 'running'/);
  });
});

describe('assertTerminalImmutable', () => {
  const settle = { settleMs: 0 };

  it('accepts a run that stopped moving', async () => {
    const inv = invFor({
      run: completedRun(),
      steps: [stepRow(0)],
      queueRows: 0,
      pendingWaits: 0,
    });
    const run = await inv.assertTerminalImmutable('r1', settle);
    expect(run.status).toBe('completed');
  });

  it('detects a terminal run without finished_at', async () => {
    const inv = invFor({
      run: completedRun({ finished_at: null }),
      steps: [],
      queueRows: 0,
      pendingWaits: 0,
    });
    await expect(inv.assertTerminalImmutable('r1', settle)).rejects.toThrow(/must have finished_at/);
  });

  it('detects a queue row still held by a terminal run', async () => {
    const inv = invFor({
      run: completedRun(),
      steps: [],
      queueRows: 1,
      pendingWaits: 0,
    });
    await expect(inv.assertTerminalImmutable('r1', settle)).rejects.toThrow(/no queue row/);
  });

  it('detects a pending wait left behind by a terminal run', async () => {
    const inv = invFor({
      run: completedRun(),
      steps: [],
      queueRows: 0,
      pendingWaits: 2,
    });
    await expect(inv.assertTerminalImmutable('r1', settle)).rejects.toThrow(/no pending wait/);
  });

  it('detects the run row changing while settling (a zombie still writes)', async () => {
    let runReads = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM runs')) {
          runReads += 1;
          const status = runReads === 1 ? 'completed' : 'running';
          return { rows: [completedRun({ status, finished_at: runReads === 1 ? at('2026-01-01T00:00:02Z') : null })] };
        }
        if (sql.includes('FROM run_steps')) return { rows: [] };
        if (sql.includes('FROM queue') || sql.includes('FROM waits')) return { rows: [{ n: 0 }] };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    } as unknown as Pool;
    await expect(createInvariants(pool).assertTerminalImmutable('r1', settle)).rejects.toThrow(
      /terminal state changed after settling/,
    );
  });

  it('compares the second call against the earliest snapshot (widest window)', async () => {
    const state: FakeState = { run: completedRun(), steps: [], queueRows: 0, pendingWaits: 0 };
    const inv = invFor(state);
    await inv.assertTerminalImmutable('r1', settle);
    state.run = completedRun({ output: { done: 'mutated later' } });
    await expect(inv.assertTerminalImmutable('r1', settle)).rejects.toThrow(
      /terminal state changed after settling/,
    );
  });
});
