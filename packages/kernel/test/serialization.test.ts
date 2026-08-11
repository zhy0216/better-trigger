/* =============================================================================
   @better-trigger/kernel — C3 serialization boundaries unit tests.

   Every persistence path must refuse what JSON cannot represent (circular /
   BigInt / over-limit values) with a stable KernelError code instead of a raw
   TypeError that would surface as a 500 — and values that MUST land (errors,
   log lines) degrade with a diagnostic rather than disappear. All driven
   through fake pools/clients; no Postgres.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError, type Namespace } from '@better-trigger/core';
import {
  appendLogs,
  batchTriggerChild,
  completeRun,
  createRunIn,
  failRun,
  reportStep,
  terminalFail,
  wakeParentIfWaiting,
  type FailRunArgs,
  type ReportStepArgs,
} from '../src/runs';

const TEST_NS: Namespace = { projectId: 'default', env: 'dev' };

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
  code_version: null,
  fencing_token: '7',
};

const ENV_VARS = [
  'BETTER_TRIGGER_MAX_PAYLOAD_BYTES',
  'BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES',
  'BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES',
  'BETTER_TRIGGER_ERROR_MAX_BYTES',
  'BETTER_TRIGGER_LOG_DATA_MAX_BYTES',
  'BETTER_TRIGGER_LOG_BATCH_MAX_BYTES',
] as const;

afterEach(() => {
  for (const name of ENV_VARS) delete process.env[name];
});

/** Recording client that plays the fencing queries and accepts every write. */
function makeClient() {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const tx: string[] = [];
  const client = {
    query: async (sql: string, p: unknown[] = []) => {
      sqls.push(sql);
      params.push(p);
      if (/^BEGIN/.test(sql)) {
        tx.push('BEGIN');
        return { rows: [], rowCount: 0 };
      }
      if (/^COMMIT/.test(sql)) {
        tx.push('COMMIT');
        return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK/.test(sql)) {
        tx.push('ROLLBACK');
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM queue') && sql.includes('locked_by')) {
        return { rows: [{ locked_by: 'w1' }], rowCount: 1 };
      }
      if (/UPDATE queue|UPDATE runs|UPDATE waits|DELETE FROM queue/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO runs/.test(sql)) {
        // Echo the pre-generated run ids back: the single path only checks
        // rows.length, and the batch path (PF5) needs RETURNING to carry the
        // id of each VALUES row — every 13th param, starting at the first.
        return { rows: p.filter((_, i) => i % 13 === 0).map((id) => ({ id: String(id) })) };
      }
      if (/INSERT INTO run_steps/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM runs/.test(sql)) return { rows: [RUNNING_ROW], rowCount: 1 };
      if (sql.includes('child_run_id')) {
        return {
          rows: [
            {
              id: 1,
              run_id: 'parent',
              project_id: 'default',
              env: 'dev',
              step_seq: 0,
              fingerprint: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM waits/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, sqls, params, tx };
}

const report = (overrides: Partial<ReportStepArgs> = {}): ReportStepArgs => ({
  runId: 'r1',
  namespace: TEST_NS,
  seq: 0,
  kind: 'step',
  label: 'work',
  status: 'completed',
  attempt: 1,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  workerId: 'w1',
  fencingToken: 7,
  ...overrides,
});

/* ---------------------------------------------------------------------------
 * createRunIn — payload
 * ------------------------------------------------------------------------- */

describe('createRunIn payload serialization (C3)', () => {
  it('rejects a circular payload with serialization_error before any query', async () => {
    const { pool, sqls } = makeClient();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    await expect(
      createRunIn(pool as unknown as PoolClient, {
        taskId: 't',
        payload: circular,
        triggerType: 'api',
        namespace: TEST_NS,
      }),
    ).rejects.toMatchObject({ code: 'serialization_error' });
    expect(sqls).toEqual([]);
  });

  it('rejects a BigInt payload with serialization_error', async () => {
    const { pool, sqls } = makeClient();
    const err = await createRunIn(pool as unknown as PoolClient, {
      taskId: 't',
      payload: { n: 1n },
      triggerType: 'api',
      namespace: TEST_NS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe('serialization_error');
    expect(sqls).toEqual([]);
  });

  it('rejects an over-limit payload with payload_too_large naming the field', async () => {
    process.env.BETTER_TRIGGER_MAX_PAYLOAD_BYTES = '64';
    const { pool } = makeClient();
    const err = await createRunIn(pool as unknown as PoolClient, {
      taskId: 't',
      payload: 'x'.repeat(100),
      triggerType: 'api',
      namespace: TEST_NS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe('payload_too_large');
    expect((err as KernelError).message).toContain('payload');
    expect((err as KernelError).message).toContain('at most 64 bytes');
  });

  it('still accepts a serializable payload under the cap', async () => {
    const { client, sqls } = makeClient();
    await createRunIn(client, {
      taskId: 't',
      payload: { ok: true },
      triggerType: 'api',
      namespace: TEST_NS,
    }).catch(() => {});
    expect(sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * reportStep / upsertStep — step output & error
 * ------------------------------------------------------------------------- */

describe('step output serialization (C3)', () => {
  it('turns an over-limit output into a FAILED step row with a diagnostic, then rejects', async () => {
    process.env.BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES = '32';
    const { pool, params, tx } = makeClient();
    await expect(
      reportStep(pool, report({ status: 'completed', output: 'x'.repeat(100) })),
    ).rejects.toMatchObject({ code: 'payload_too_large' });

    const insert = params.find((p) => p[4] === 'step' && p.length === 13);
    expect(insert).toBeDefined();
    // status flipped to 'failed'; error carries the stable diagnostic.
    expect(insert?.[6]).toBe('failed');
    expect(insert?.[7]).toBeNull();
    expect(String(insert?.[8])).toContain('SerializationError');
    expect(String(insert?.[8])).toContain('output');
    // The failed row is COMMITTED before the rejection is raised — the run's
    // timeline keeps its evidence even though the run goes on to fail.
    expect(tx).toEqual(['BEGIN', 'COMMIT']);
  });

  it('turns a circular output into a FAILED step row with serialization_error', async () => {
    const { pool, params } = makeClient();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    await expect(
      reportStep(pool, report({ output: circular })),
    ).rejects.toMatchObject({ code: 'serialization_error' });

    const insert = params.find((p) => p[4] === 'step' && p.length === 13);
    expect(insert?.[6]).toBe('failed');
    expect(String(insert?.[8])).toContain('SerializationError');
  });

  it('degrades an over-limit step error instead of losing the failed row', async () => {
    process.env.BETTER_TRIGGER_ERROR_MAX_BYTES = '32';
    const { pool, params } = makeClient();
    await expect(
      reportStep(
        pool,
        report({
          status: 'failed',
          output: undefined,
          error: { message: 'x'.repeat(200), name: 'Boom', stack: 'y'.repeat(200) },
        }),
      ),
    ).resolves.toBeUndefined();

    const insert = params.find((p) => p[4] === 'step' && p.length === 13);
    expect(insert?.[6]).toBe('failed');
    expect(String(insert?.[8])).toContain('SerializationError');
  });
});

/* ---------------------------------------------------------------------------
 * completeRun — run output
 * ------------------------------------------------------------------------- */

describe('completeRun output serialization (C3)', () => {
  it('rejects an over-limit output with payload_too_large and writes nothing', async () => {
    process.env.BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES = '32';
    const { pool, sqls, tx } = makeClient();
    await expect(
      completeRun(pool, {
        runId: 'r1',
        output: 'x'.repeat(100),
        workerId: 'w1',
        fencingToken: 7,
        namespace: TEST_NS,
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    // The tx was opened and the fencing locks taken, then rolled back with no
    // completion UPDATE — the run keeps its 'running' row for the executor to fail.
    expect(sqls.some((s) => /UPDATE runs/.test(s))).toBe(false);
    expect(tx).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('rejects a circular output with serialization_error', async () => {
    const { pool } = makeClient();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    await expect(
      completeRun(pool, {
        runId: 'r1',
        output: circular,
        workerId: 'w1',
        fencingToken: 7,
        namespace: TEST_NS,
      }),
    ).rejects.toMatchObject({ code: 'serialization_error' });
  });

  it('stores a serializable output', async () => {
    const { pool, params } = makeClient();
    await completeRun(pool, {
      runId: 'r1',
      output: { ok: true },
      workerId: 'w1',
      fencingToken: 7,
      namespace: TEST_NS,
    });
    const update = params.find((p) => p.length === 4 && p[0] === 'r1' && p[1] !== undefined && p.length === 4);
    expect(update?.[1]).toBe('{"ok":true}');
  });
});

/* ---------------------------------------------------------------------------
 * terminalFail / failRun — error records
 * ------------------------------------------------------------------------- */

describe('error record serialization (C3)', () => {
  it('terminalFail degrades an over-limit error instead of failing the transition', async () => {
    process.env.BETTER_TRIGGER_ERROR_MAX_BYTES = '32';
    const { client, params } = makeClient();
    await terminalFail(client, RUNNING_ROW, { message: 'x'.repeat(200) });
    // The runs UPDATE binds the degraded stub at $2, so the transition lands.
    const update = params.find((p) => p.length === 4 && String(p[1]).includes('SerializationError'));
    expect(update).toBeDefined();
  });

  it('failRun (retry branch) degrades an over-limit error', async () => {
    process.env.BETTER_TRIGGER_ERROR_MAX_BYTES = '32';
    const { pool, params } = makeClient();
    const res = await failRun(pool, {
      runId: 'r1',
      error: { message: 'x'.repeat(200), stack: 'y'.repeat(200) },
      workerId: 'w1',
      fencingToken: 7,
      namespace: TEST_NS,
    } satisfies FailRunArgs);
    expect(res.willRetry).toBe(true);
    // The queued-status update binds the degraded error at $2.
    const update = params.find((p) => p.length === 4 && String(p[1]).includes('SerializationError'));
    expect(update).toBeDefined();
  });
});

/* ---------------------------------------------------------------------------
 * appendLogs — per-line data cap + per-statement byte cap
 * ------------------------------------------------------------------------- */

interface Stmt {
  sql: string;
  params: unknown[];
}

const makeLogPool = () => {
  const stmts: Stmt[] = [];
  const inserted: { runId: string; rows: number }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      const rows = (params.length - 3) / 5;
      if (rows > 0) inserted.push({ runId: params[0] as string, rows });
      return { rows: [], rowCount: rows };
    },
  } as unknown as Pool;
  return { pool, stmts, inserted };
};

describe('appendLogs serialization (C3)', () => {
  it('keeps an over-limit data line, replacing its data with a diagnostic', async () => {
    process.env.BETTER_TRIGGER_LOG_DATA_MAX_BYTES = '16';
    const { pool, stmts } = makeLogPool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
      {
        ts: '2026-07-30T00:00:00.000Z',
        level: 'info',
        message: 'keep me',
        data: 'x'.repeat(100),
      },
    ]);

    expect(stmts).toHaveLength(1);
    const [data, message] = [stmts[0]!.params[6], stmts[0]!.params[5]];
    expect(message).toBe('keep me');
    const marker = JSON.parse(String(data)) as { omitted: boolean; reason: string };
    expect(marker.omitted).toBe(true);
    expect(marker.reason).toContain('data');
    expect(marker.reason).toContain('at most 16 bytes');
  });

  it('keeps a line whose data is circular, with the diagnostic in data', async () => {
    const { pool, stmts } = makeLogPool();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
      { ts: '2026-07-30T00:00:00.000Z', level: 'warn', message: 'boom', data: circular },
    ]);
    const marker = JSON.parse(String(stmts[0]!.params[6])) as { omitted: boolean };
    expect(marker.omitted).toBe(true);
  });

  it('splits a flush over the per-statement byte cap into several statements', async () => {
    process.env.BETTER_TRIGGER_LOG_BATCH_MAX_BYTES = '500';
    const { pool, stmts, inserted } = makeLogPool();
    const entries = Array.from({ length: 20 }, (_, i) => ({
      ts: '2026-07-30T00:00:00.000Z',
      level: 'info' as const,
      message: `line ${i}`,
      data: 'y'.repeat(60),
    }));
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries);

    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) {
      const stmtBytes = s.params
        .map((p) => new TextEncoder().encode(String(p)).length)
        .reduce((n, b) => n + b, 0);
      expect(stmtBytes).toBeLessThanOrEqual(500);
      expect(s.sql).toMatch(/finished_at IS NULL/);
    }
    expect(inserted.reduce((n, i) => n + i.rows, 0)).toBe(20);
  });

  it('truncates an over-long message instead of dropping the line', async () => {
    process.env.BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES = '64';
    const { pool, stmts } = makeLogPool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
      { ts: '2026-07-30T00:00:00.000Z', level: 'info', message: 'x'.repeat(200) },
    ]);

    expect(stmts).toHaveLength(1);
    const msg = String(stmts[0]!.params[5]);
    expect(msg.endsWith('…')).toBe(true);
    expect(new TextEncoder().encode(msg).length).toBeLessThanOrEqual(64);
  });

  it('shrinks a single line that alone exceeds the batch cap — data degraded, message trimmed, line kept', async () => {
    // The per-line data cap is raised above the line's data, so the per-line
    // degradation does NOT fire; the batch cap is the one that is exceeded by
    // this single line, which is what shrinkRowForBatch must handle.
    process.env.BETTER_TRIGGER_LOG_DATA_MAX_BYTES = '20000';
    process.env.BETTER_TRIGGER_LOG_BATCH_MAX_BYTES = '1000';
    const { pool, stmts, inserted } = makeLogPool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
      {
        ts: '2026-07-30T00:00:00.000Z',
        level: 'info',
        message: 'huge data line',
        data: 'y'.repeat(15000),
      },
    ]);

    expect(stmts).toHaveLength(1);
    const marker = JSON.parse(String(stmts[0]!.params[6])) as {
      omitted: boolean;
      reason: string;
    };
    expect(marker.omitted).toBe(true);
    expect(marker.reason).toContain('log batch cap');
    expect(stmts[0]!.params[5]).toBe('huge data line'); // message survives
    expect(inserted.reduce((n, i) => n + i.rows, 0)).toBe(1);
  });

  it('never emits an INSERT over the batch cap, whatever the line contents', async () => {
    process.env.BETTER_TRIGGER_LOG_DATA_MAX_BYTES = '100000';
    process.env.BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES = '100000';
    process.env.BETTER_TRIGGER_LOG_BATCH_MAX_BYTES = '300';
    const { pool, stmts } = makeLogPool();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ts: '2026-07-30T00:00:00.000Z',
      level: 'info' as const,
      message: `m${i} ` + 'x'.repeat(500),
      data: 'y'.repeat(500),
    }));
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries);

    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      const stmtBytes = s.params
        .map((p) => new TextEncoder().encode(String(p)).length)
        .reduce((n, b) => n + b, 0);
      expect(stmtBytes).toBeLessThanOrEqual(300);
    }
  });
});

/* ---------------------------------------------------------------------------
 * batchTriggerChild / wakeParentIfWaiting — StepWriteOutcome is not ignored
 * ------------------------------------------------------------------------- */

describe('batchTriggerChild step-row failure (C3)', () => {
  it('fails after COMMIT when the batch step output cannot be recorded — no re-creatable fan-out', async () => {
    // runIds serializes to ~27 bytes; an operator-tuned 16-byte step cap makes
    // the batch step row unrecordable.
    process.env.BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES = '16';
    const { pool, tx } = makeClient();
    await expect(
      batchTriggerChild(pool, {
        runId: 'r1',
        namespace: TEST_NS,
        seq: 0,
        label: 'fan',
        items: [{ taskId: 't', payload: null }],
        workerId: 'w1',
        fencingToken: 7,
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    // The tx COMMITTED: the children and the failed step row landed. Raising
    // the error after commit is what stops a replay from re-creating the
    // fan-out (the executor converts it to a non-retryable AbortError).
    expect(tx).toEqual(['BEGIN', 'COMMIT']);
  });

  it('rejects an over-cap child payload BEFORE the transaction opens — zero SQL (PF5)', async () => {
    // The whole batch is validated + serialized before the tx (same as the
    // client-side path): a payload that cannot be stored costs no round trips
    // and not even a connection-level BEGIN.
    process.env.BETTER_TRIGGER_MAX_PAYLOAD_BYTES = '16';
    const { pool, sqls, tx } = makeClient();
    await expect(
      batchTriggerChild(pool, {
        runId: 'r1',
        namespace: TEST_NS,
        seq: 0,
        label: 'fan',
        items: [{ taskId: 't', payload: 'x'.repeat(100) }],
        workerId: 'w1',
        fencingToken: 7,
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(tx).toEqual([]);
    expect(sqls).toEqual([]);
  });

  it('returns the recorded runIds on a healthy write', async () => {
    const { pool } = makeClient();
    const res = await batchTriggerChild(pool, {
      runId: 'r1',
      namespace: TEST_NS,
      seq: 0,
      label: 'fan',
      items: [{ taskId: 't', payload: null }],
      workerId: 'w1',
      fencingToken: 7,
    });
    // createRunIn returns the run id it generated (run_…), not the stub's row.
    expect(res.runIds).toHaveLength(1);
    expect(res.runIds[0]).toMatch(/^run_/);
  });
});

describe('wakeParentIfWaiting step-row failure (C3)', () => {
  it('rejects when the child result cannot fit the parent step row', async () => {
    process.env.BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES = '32';
    const { client, sqls } = makeClient();
    await expect(
      wakeParentIfWaiting(client, 'child_run_1', { ok: true, output: 'x'.repeat(100) }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    // The wait had already been flipped to 'completed' inside the (would-be)
    // caller tx; the rejection rolls it back, so the parent is never
    // re-enqueued and never replays into a duplicate child.
    expect(sqls.some((s) => /UPDATE waits SET status = 'completed'/.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE runs SET status = 'queued'/.test(s))).toBe(false);
  });
});
