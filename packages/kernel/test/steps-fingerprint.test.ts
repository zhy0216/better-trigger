/* =============================================================================
   @better-trigger/kernel — C1 step-row immutability unit tests.
   upsertStep (reached through reportStep) must keep a completed step row
   byte-identical on any re-report, treating only these as passable: a
   non-completed row (the retry path overwrites), an idempotent replay (equal
   fingerprints), and a NULL fingerprint on either side (legacy data / legacy
   reporter — lenient). A completed row reported with a different fingerprint
   is refused with NonDeterminismError. The fake client simulates Postgres'
   ON CONFLICT ... WHERE status <> 'completed' rowCount semantics in memory.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { NonDeterminismError } from '@better-trigger/core';
import { canonicalStringify, stepFingerprint } from '../src/fingerprint';
import { reportStep, type ReportStepArgs } from '../src/runs';

interface FakeRow {
  status: string;
  kind: string;
  label: string | null;
  output: unknown;
  fingerprint: string | null;
}

const RUNNING_ROW = {
  id: 'r1',
  task_id: 't',
  status: 'running',
  attempt: 1,
  max_attempts: 3,
  recoveries: 0,
  max_recoveries: 10,
  parent_run_id: null,
  payload: null,
  env: 'dev',
  concurrency_key: null,
  priority: 0,
  code_version: 'v_test',
  fencing_token: '7',
};

/** Fake pool: fencing queries answer "owned + running", run_steps behaves like
 *  the real upsert (conflict on a completed row → rowCount 0, SELECT follows). */
function makeFake() {
  const table = new Map<string, FakeRow>();
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM queue')) return { rows: [{ locked_by: 'w1' }], rowCount: 1 };
      if (sql.includes('FROM runs')) return { rows: [RUNNING_ROW], rowCount: 1 };
      if (sql.startsWith('INSERT INTO run_steps')) {
        const key = `${params[0]}:${params[1]}`;
        const existing = table.get(key);
        if (existing && existing.status === 'completed') return { rows: [], rowCount: 0 };
        table.set(key, {
          status: params[4] as string,
          kind: params[2] as string,
          label: (params[3] as string | null) ?? null,
          output: params[5] ?? null,
          fingerprint: (params[10] as string | null) ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT status, fingerprint')) {
        const row = table.get(`${params[0]}:${params[1]}`);
        return { rows: row ? [{ status: row.status, fingerprint: row.fingerprint }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, table };
}

const report = (fingerprint?: string, status: 'completed' | 'failed' = 'completed') =>
  ({
    runId: 'r1',
    seq: 0,
    kind: 'step',
    label: 'work',
    status,
    output: { ok: true },
    attempt: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    fingerprint,
    workerId: 'w1',
    fencingToken: 7,
  }) satisfies ReportStepArgs;

describe('reportStep fingerprint immutability (C1)', () => {
  it('inserts the fingerprint on first report and treats an identical re-report as an idempotent no-op', async () => {
    const { pool, table } = makeFake();
    await reportStep(pool, report('fp_a'));

    const row = table.get('r1:0');
    expect(row?.status).toBe('completed');
    expect(row?.fingerprint).toBe('fp_a');

    await reportStep(pool, report('fp_a')); // same fingerprint → no throw
    expect(table.get('r1:0')?.fingerprint).toBe('fp_a');
  });

  it('refuses to overwrite a completed row whose fingerprint differs — NonDeterminismError', async () => {
    const { pool, table } = makeFake();
    await reportStep(pool, report('fp_old'));

    await expect(reportStep(pool, report('fp_new'))).rejects.toBeInstanceOf(NonDeterminismError);
    const row = table.get('r1:0');
    expect(row?.status).toBe('completed');
    expect(row?.fingerprint).toBe('fp_old'); // recorded row left intact
  });

  it('names the run, seq, kind and both fingerprints in the NonDeterminismError', async () => {
    const { pool } = makeFake();
    await reportStep(pool, report('fp_old'));

    const err = await reportStep(pool, report('fp_new')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonDeterminismError);
    const message = (err as Error).message;
    expect(message).toContain('run r1 seq 0');
    expect(message).toContain('kind \'step\'');
    expect(message).toContain('fp_old');
    expect(message).toContain('fp_new');
  });

  it('treats a completed row with a NULL stored fingerprint as legacy-lenient (no throw, row intact)', async () => {
    const { pool, table } = makeFake();
    await reportStep(pool, report(undefined)); // legacy reporter → NULL fingerprint

    await reportStep(pool, report('fp_new')); // new code, legacy row → lenient no-op
    expect(table.get('r1:0')?.fingerprint).toBeNull();
    expect(table.get('r1:0')?.status).toBe('completed');
  });

  it('treats a completed row reported without a fingerprint as legacy-lenient (no throw, row intact)', async () => {
    const { pool, table } = makeFake();
    await reportStep(pool, report('fp_old'));

    await reportStep(pool, report(undefined)); // old reporter over a fingerprinted row
    expect(table.get('r1:0')?.fingerprint).toBe('fp_old');
  });

  it('overwrites a non-completed (failed) row with the new fingerprint — the retry path', async () => {
    const { pool, table } = makeFake();
    await reportStep(pool, report('fp_attempt1', 'failed'));

    await reportStep(pool, report('fp_attempt2')); // retry succeeds, new code even
    const row = table.get('r1:0');
    expect(row?.status).toBe('completed');
    expect(row?.fingerprint).toBe('fp_attempt2');
  });
});

describe('canonical fingerprint serialization (C1)', () => {
  it('hashes two objects that differ only in key order identically', () => {
    const base = { kind: 'step', label: 'work', codeVersion: 'v1' } as const;
    expect(
      stepFingerprint({ ...base, input: { fn: 'abc', payload: { a: 1, b: 2 } } }),
    ).toBe(stepFingerprint({ ...base, input: { payload: { b: 2, a: 1 }, fn: 'abc' } }));
  });

  it('matches JSON.stringify value semantics (toJSON, undefined members, arrays)', () => {
    expect(canonicalStringify({ d: new Date('2030-01-01T00:00:00.000Z') })).toBe(
      JSON.stringify({ d: '2030-01-01T00:00:00.000Z' }),
    );
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalStringify([undefined, 1])).toBe('[null,1]');
  });

  it('rejects circular structures instead of hashing garbage', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => canonicalStringify(circular)).toThrow(TypeError);
  });

  it('sorts keys recursively, including nested objects and arrays', () => {
    const sorted = canonicalStringify({ z: [3, { y: 2, x: 1 }], a: { d: 4, c: { b: 5 } } });
    expect(sorted).toBe('{"a":{"c":{"b":5},"d":4},"z":[3,{"x":1,"y":2}]}');
  });
});
