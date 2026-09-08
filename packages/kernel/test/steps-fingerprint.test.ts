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
import { NonDeterminismError, safeSerializeJson, type Namespace } from '@better-trigger/core';
import { canonicalStringify, fnSourceHash, stepFingerprint, type StepFingerprintArgs } from '../src/fingerprint';
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
  project_id: 'default',
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
        // $1 run id, $2/$3 namespace, $4 seq — the ledger key is run:seq.
        const key = `${params[0]}:${params[3]}`;
        const existing = table.get(key);
        if (existing && existing.status === 'completed') return { rows: [], rowCount: 0 };
        table.set(key, {
          status: params[6] as string,
          kind: params[4] as string,
          label: (params[5] as string | null) ?? null,
          output: params[7] ?? null,
          fingerprint: (params[12] as string | null) ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT status, fingerprint')) {
        const row = table.get(`${params[0]}:${params[3]}`);
        return { rows: row ? [{ status: row.status, fingerprint: row.fingerprint }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, table };
}

const TEST_NS: Namespace = { projectId: 'default', env: 'dev' };

const report = (fingerprint?: string, status: 'completed' | 'failed' = 'completed') =>
  ({
    runId: 'r1',
    namespace: TEST_NS,
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
  // Captured from the pre-fix v1 implementation, not recomputed expectations.
  // Keep every primitive kind plus null/empty/versioned labels and code versions.
  const goldens: Array<[StepFingerprintArgs, string]> = [
    [{ kind: 'step', label: 'fetch', input: { z: [3, { y: 2, a: 1 }], a: true }, codeVersion: null }, 'a1b963681f4d20de'],
    [{ kind: 'step', label: 'work', input: { fn: 'abc', opts: { retry: { maxAttempts: 3, baseMs: 100 } } }, codeVersion: 'deploy-1' }, '05c5f87e5cc0ff04'],
    [{ kind: 'step', label: '', input: { '10': 'ten', '2': 'two', b: 2, '01': 'one', a: 1 }, codeVersion: '' }, 'b3e4e5445d94ec1a'],
    [{ kind: 'wait', label: null, input: { duration: '1h' }, codeVersion: 'v1' }, '34dba539978a32cf'],
    [{ kind: 'wait', label: null, input: { until: '2030-01-01T00:00:00.000Z' }, codeVersion: null }, '80b9eb23b8884e2c'],
    [{ kind: 'trigger-and-wait', label: null, input: { taskId: 'child', payload: { z: [3, { y: 2, a: 1 }], a: true }, options: undefined }, codeVersion: 'v1' }, '644380abaa75f8e8'],
    [{ kind: 'trigger-and-wait', label: null, input: { taskId: 'child', payload: { z: [3, { y: 2, a: 1 }], a: true }, options: {} }, codeVersion: 'v1' }, 'd4934a8d1f4e3e61'],
    [{ kind: 'batch-trigger', label: 'fan-out', input: { items: [{ taskId: 'child', payload: { b: 2, a: 1 } }, { taskId: 'child', payload: ['中😀', null], options: { priority: 2 } }] }, codeVersion: 'v1' }, 'bc188ac32ee14202'],
    [{ kind: 'now', label: null, input: {}, codeVersion: null }, 'f035cc26e8e526e3'],
    [{ kind: 'random', label: null, input: {}, codeVersion: 'v1' }, 'e683c836a425fc02'],
    [{ kind: 'uuid', label: null, input: {}, codeVersion: 'v2' }, '105a3257a7486320'],
    [{ kind: 'step', label: '中😀', input: { z: '\n"\\', a: '\ud800' }, codeVersion: 'v1' }, 'ef7ea4faaffdd5db'],
    [{ kind: 'step', label: null, input: null, codeVersion: null }, '163b0d2986cbae54'],
  ];

  it.each(goldens)('preserves the existing v1 golden %j', (args, fingerprint) => {
    expect(stepFingerprint(args)).toBe(fingerprint);
    expect(stepFingerprint(JSON.parse(JSON.stringify(args)))).toBe(fingerprint);
  });

  it('preserves fnSourceHash and nullish envelope normalization', () => {
    expect(fnSourceHash('() => 42')).toBe('e5afcafb4e2aff0d');
    expect(stepFingerprint({ kind: 'step', label: null, input: undefined, codeVersion: null })).toBe('163b0d2986cbae54');
  });

  it('terminates self-returning toJSON once per JSON position', () => {
    const calls: string[] = [];
    const value = {
      z: 2, a: 1,
      toJSON(key: string) {
        calls.push(key);
        // Bound the old recursive implementation too: a failing test must
        // never pin a CPU or depend on a synchronous timeout to rescue it.
        if (calls.length > 3) throw new Error('toJSON re-entered');
        return this;
      },
    };
    expect(canonicalStringify({ left: value, right: [value] })).toBe('{"left":{"a":1,"z":2},"right":[{"a":1,"z":2}]}');
    expect(calls).toEqual(['left', '0']);
    expect(canonicalStringify(value)).toBe('{"a":1,"z":2}');
    expect(calls).toEqual(['left', '0', '']);
  });

  it('preserves own special keys and distinguishes their absence without mutation', () => {
    const input = JSON.parse('{"__proto__":{"secret":true},"a":2,"nested":[{"__proto__":null,"constructor":3,"prototype":4}]}');
    const before = JSON.stringify(input);
    const serialized = safeSerializeJson(input);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw new Error('fixture must serialize');
    expect(canonicalStringify(input)).toBe(serialized.json);
    expect(JSON.parse(canonicalStringify(input))).toEqual(input);
    const without = { a: input.a, nested: input.nested };
    const base = { kind: 'step', label: 'special', codeVersion: 'v1' } as const;
    expect(stepFingerprint({ ...base, input })).not.toBe(stepFingerprint({ ...base, input: without }));
    expect(stepFingerprint({ ...base, input })).toBe(stepFingerprint({ ...base, input: JSON.parse(serialized.json) }));
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(Object.hasOwn(input, '__proto__')).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('shares storage semantics for boxed primitives and nested toJSON keys', () => {
    const value = {
      z: [new Number(7), new String('ok'), new Boolean(false)],
      a: { toJSON(key: string) { return { z: key, a: 1 }; } },
    };
    expect(canonicalStringify(value)).toBe('{"a":{"a":1,"z":"a"},"z":[7,"ok",false]}');
    expect(safeSerializeJson(value)).toMatchObject({ ok: true, json: canonicalStringify(value) });
  });

  it('does not invoke toJSON on the value returned by a hook', () => {
    const returned = { a: 1, toJSON() { throw new Error('must not be re-entered'); } };
    expect(canonicalStringify({ toJSON: () => returned })).toBe('{"a":1}');
  });

  it.each([undefined, () => {}, Symbol('x'), { toJSON: () => undefined }, 1n, Object(1n)])(
    'refuses a root without valid JSON instead of inventing a fingerprint marker: %s', (value) => {
      expect(() => canonicalStringify(value)).toThrow(TypeError);
    },
  );

  it('rejects BigInt fingerprint inputs and cycles behind self-returning hooks', () => {
    const base = { kind: 'step', label: 'work', codeVersion: 'v1' } as const;
    for (const input of [1n, { n: 1n }, [Object(1n)]]) {
      expect(() => stepFingerprint({ ...base, input })).toThrow(TypeError);
    }
    let calls = 0;
    const cycle: Record<string, unknown> = {
      toJSON() {
        if (++calls > 2) throw new Error('toJSON re-entered');
        return this;
      },
    };
    cycle.self = cycle;
    expect(() => canonicalStringify(cycle)).toThrow(TypeError);
    expect(calls).toBe(2); // root and self; the second visit reveals the cycle
  });

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
