/* =============================================================================
   @better-trigger/worker — GET /runs/:id delegates to kernel.getRunDetail
   (PF3, todos/02-performance.md).

   The route used to re-query run/steps/waits/logs itself — a second copy of
   the kernel's SQL that could drift, with no snapshot. It now calls
   kernel.getRunDetail and returns its response verbatim. What is pinned here:

     - the only statements the request issues are the kernel's: one BEGIN
       ISOLATION LEVEL REPEATABLE READ + the four reads + COMMIT — nothing
       from the route itself;
     - the wire shape carries the PF3 fields (stepsTruncated / waitsTruncated /
       logsNextCursor);
     - ?logsBefore= reaches the kernel's logs cursor;
     - a bad cursor is 400; a missing run is 404 with the error envelope.

   The kernel module is NOT mocked: this exercises the real getRunDetail
   against a stub pool that plays the four reads (no Postgres).
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Kernel } from '@better-trigger/kernel';
import { createApp } from '../src/app';

interface Stmt {
  sql: string;
  params: unknown[];
}

const RUN_ROW = {
  id: 'run_1',
  task_id: 't',
  status: 'completed',
  trigger_type: 'api',
  code_version: 'v7',
  project_id: 'default',
  env: 'prod',
  attempt: 1,
  max_attempts: 3,
  payload: { n: 1 },
  output: 'done',
  error: null,
  parent_run_id: null,
  idempotency_key: null,
  queued_at: null,
  created_at: new Date('2026-08-01T00:00:00Z'),
  started_at: new Date('2026-08-01T00:00:01Z'),
  finished_at: new Date('2026-08-01T00:00:02Z'),
};

interface LogRow {
  id: number;
  step_seq: number | null;
  level: string;
  message: string;
  data: unknown;
  ts: Date;
}

const logRow = (id: number): LogRow => ({
  id,
  step_seq: null,
  level: 'info',
  message: `line ${id}`,
  data: null,
  ts: new Date(1_752_480_000_000 + id),
});

/** Stub pool playing the four kernel reads; records every statement. */
function makeDb(opts: { run?: boolean; logs?: LogRow[] } = {}) {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/^BEGIN/.test(sql)) return { rows: [] };
      if (/^COMMIT/.test(sql)) return { rows: [] };
      if (/^ROLLBACK/.test(sql)) return { rows: [] };
      if (/FROM runs/.test(sql)) {
        return { rows: opts.run === false ? [] : [RUN_ROW] };
      }
      if (/FROM run_steps/.test(sql)) return { rows: [] };
      if (/FROM waits/.test(sql)) return { rows: [] };
      if (/FROM logs/.test(sql)) {
        const before = params.length > 4 ? (params[3] as number) : undefined;
        const limit = params[params.length - 1] as number;
        const base = before === undefined ? (opts.logs ?? []) : (opts.logs ?? []).filter((l) => l.id < before);
        return { rows: [...base].sort((a, b) => b.id - a.id).slice(0, limit) };
      }
      throw new Error('unexpected statement: ' + sql);
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, stmts };
}

const app = (db: ReturnType<typeof makeDb>) =>
  createApp({ kernel: {} as unknown as Kernel, pool: db.pool });

describe('GET /runs/:id', () => {
  it('delegates to kernel.getRunDetail — zero route-owned queries', async () => {
    const db = makeDb({ logs: [logRow(1), logRow(2)] });
    const res = await app(db).request('/api/v1/runs/run_1?projectId=default&env=prod');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { id: string };
      steps: unknown[];
      waits: unknown[];
      logs: { id: number }[];
      stepsTruncated: boolean;
      waitsTruncated: boolean;
      logsNextCursor: number | null;
    };
    expect(body.run.id).toBe('run_1');
    expect(body.logs.map((l) => l.id)).toEqual([1, 2]);
    expect(body.stepsTruncated).toBe(false);
    expect(body.waitsTruncated).toBe(false);
    expect(body.logsNextCursor).toBe(null);

    // The ONLY statements the request issued are the kernel's transaction —
    // the route itself never touched the pool.
    expect(db.stmts.map((s) => s.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      expect.stringMatching(/FROM runs WHERE id = \$1 AND project_id = \$2 AND env = \$3/),
      expect.stringMatching(/FROM run_steps/),
      expect.stringMatching(/FROM waits/),
      expect.stringMatching(/FROM logs/),
      'COMMIT',
    ]);
  });

  it('passes ?logsBefore= through to the kernel logs cursor', async () => {
    const db = makeDb({ logs: [logRow(5), logRow(6)] });
    const res = await app(db).request('/api/v1/runs/run_1?projectId=default&env=prod&logsBefore=6');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: { id: number }[]; logsNextCursor: number | null };
    expect(body.logs.map((l) => l.id)).toEqual([5]);
    expect(body.logsNextCursor).toBe(null);

    const logsStmt = db.stmts.find((s) => /FROM logs/.test(s.sql));
    expect(logsStmt?.params[3]).toBe(6);
  });

  it('answers 400 bad_request for a non-integer logsBefore', async () => {
    const db = makeDb();
    const res = await app(db).request('/api/v1/runs/run_1?projectId=default&env=prod&logsBefore=abc');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('answers 404 with the error envelope for a missing run', async () => {
    const db = makeDb({ run: false });
    const res = await app(db).request('/api/v1/runs/nope?projectId=default&env=prod');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('nope');
  });
});
