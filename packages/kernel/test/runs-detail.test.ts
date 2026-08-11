/* =============================================================================
   @better-trigger/kernel — run detail snapshot + pagination (PF3,
   todos/02-performance.md).

   getRunDetail used to be four independent reads (run, steps, waits, logs —
   logs capped at the OLDEST 1000 rows, so a long run's last error could be cut
   off). It is now ONE REPEATABLE READ transaction over all four tables, with
   the logs page reversed to show the newest 200 lines chronologically and an
   id cursor (`logsBefore`) to walk back to older pages; steps/waits are capped
   at the newest rows with a truncated flag.

   What is pinned here:

     - the tx shape: BEGIN ISOLATION LEVEL REPEATABLE READ → the four reads →
       COMMIT, on one dedicated client, released on every path;
     - default logs page = newest 200 lines, ascending ids (chronological),
       `logsNextCursor` = the page's oldest id when older rows exist;
     - `logsBefore` walks strictly older pages until null (1200-line run);
     - steps/waits keep the newest rows and set the truncated flags;
     - a missing run rolls back and raises not_found; a bad page size /
       cursor is refused before any statement.

   No Postgres: a stub pool plays a miniature database of canned rows and
   records every statement.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { getRunDetail } from '../src/runs';

interface Stmt {
  sql: string;
  params: unknown[];
}

const RUN_ROW = {
  id: 'run_1',
  task_id: 't',
  status: 'running',
  trigger_type: 'api',
  code_version: 'v7',
  project_id: 'default',
  env: 'prod',
  attempt: 1,
  max_attempts: 3,
  payload: { n: 1 },
  output: null,
  error: null,
  parent_run_id: null,
  idempotency_key: null,
  queued_at: null,
  created_at: new Date('2026-08-01T00:00:00Z'),
  started_at: new Date('2026-08-01T00:00:01Z'),
  finished_at: null,
};

interface StepRow {
  seq: number;
  kind: string;
  label: string | null;
  status: string;
  output: unknown;
  error: unknown;
  attempt: number;
  started_at: Date | null;
  finished_at: Date | null;
}

interface WaitRow {
  id: number;
  step_seq: number;
  kind: string;
  resume_at: Date | null;
  child_run_id: string | null;
  status: string;
}

interface LogRow {
  id: number;
  step_seq: number | null;
  level: string;
  message: string;
  data: unknown;
  ts: Date;
}

const stepRow = (seq: number): StepRow => ({
  seq,
  kind: 'step',
  label: `step-${seq}`,
  status: 'completed',
  output: { seq },
  error: null,
  attempt: 1,
  started_at: new Date(1_752_480_000_000 + seq),
  finished_at: new Date(1_752_480_000_000 + seq + 10),
});

const waitRow = (id: number): WaitRow => ({
  id,
  step_seq: id,
  kind: 'duration',
  resume_at: null,
  child_run_id: null,
  status: 'completed',
});

const logRow = (id: number): LogRow => ({
  id,
  step_seq: null,
  level: 'info',
  message: `line ${id}`,
  data: null,
  ts: new Date(1_752_480_000_000 + id),
});

/** N rows starting at `from` (inclusive). */
const range = (from: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => from + i);

/**
 * A pool that plays the four reads getRunDetail issues. `run: false` stands
 * for the run row being absent (not_found); `failCommit` makes COMMIT throw
 * (a connection dropped mid-transaction). Every statement is recorded, so
 * the tests can assert the tx shape AND that nothing outside it was sent.
 */
function makeDb(opts: {
  run?: boolean;
  failCommit?: boolean;
  steps?: StepRow[];
  waits?: WaitRow[];
  logs?: LogRow[];
} = {}) {
  const stmts: Stmt[] = [];
  const counters = { connects: 0, releases: 0 };
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/^BEGIN/.test(sql)) return { rows: [] };
      if (/^COMMIT/.test(sql)) {
        if (opts.failCommit) throw new Error('connection lost');
        return { rows: [] };
      }
      if (/^ROLLBACK/.test(sql)) return { rows: [] };
      if (/FROM runs/.test(sql)) {
        return { rows: opts.run === false ? [] : [RUN_ROW] };
      }
      if (/FROM run_steps/.test(sql)) {
        // ORDER BY seq DESC LIMIT $4 — the limit is the last bind param.
        const limit = params[params.length - 1] as number;
        const rows = [...(opts.steps ?? [])].sort((a, b) => b.seq - a.seq).slice(0, limit);
        return { rows };
      }
      if (/FROM waits/.test(sql)) {
        const limit = params[params.length - 1] as number;
        const rows = [...(opts.waits ?? [])].sort((a, b) => b.id - a.id).slice(0, limit);
        return { rows };
      }
      if (/FROM logs/.test(sql)) {
        // params: run id, projectId, env, [logsBefore at $4,] limit last.
        const before = params.length > 4 ? (params[3] as number) : undefined;
        const limit = params[params.length - 1] as number;
        const base = before === undefined ? (opts.logs ?? []) : (opts.logs ?? []).filter((l) => l.id < before);
        const rows = [...base].sort((a, b) => b.id - a.id).slice(0, limit);
        return { rows };
      }
      throw new Error('unexpected statement: ' + sql);
    },
    release: () => {
      counters.releases += 1;
    },
  };
  const pool = {
    connect: async () => {
      counters.connects += 1;
      return client;
    },
  } as unknown as Pool;
  return { pool, stmts, counters };
}

const logDb = (n: number) => ({ logs: range(1, n).map(logRow) });

describe('getRunDetail — one REPEATABLE READ snapshot', () => {
  it('reads run, steps, waits, logs inside ONE BEGIN ISOLATION LEVEL REPEATABLE READ … COMMIT', async () => {
    const { pool, stmts, counters } = makeDb({ ...logDb(5), steps: range(0, 2).map(stepRow) });

    await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(counters.connects).toBe(1);
    expect(counters.releases).toBe(1);
    expect(stmts.map((s) => s.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      expect.stringMatching(/FROM runs WHERE id = \$1 AND project_id = \$2 AND env = \$3/),
      expect.stringMatching(/FROM run_steps WHERE run_id = \$1 AND project_id = \$2 AND env = \$3 ORDER BY seq DESC LIMIT \$4/),
      expect.stringMatching(/FROM waits WHERE run_id = \$1 AND project_id = \$2 AND env = \$3 ORDER BY id DESC LIMIT \$4/),
      expect.stringMatching(/FROM logs WHERE run_id = \$1 AND project_id = \$2 AND env = \$3 ORDER BY id DESC LIMIT \$4/),
      'COMMIT',
    ]);
  });

  it('rolls back, not commits, when the run is missing (not_found)', async () => {
    const { pool, stmts, counters } = makeDb({ run: false, ...logDb(3) });

    await expect(getRunDetail(pool, 'nope', DEFAULT_NAMESPACE)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(stmts.map((s) => s.sql)).toContain('ROLLBACK');
    expect(stmts.map((s) => s.sql)).not.toContain('COMMIT');
    expect(counters.releases).toBe(1);
  });

  it('refuses a bad cursor/page size before issuing any statement', async () => {
    for (const opts of [
      { logsBefore: 0 },
      { logsBefore: -5 },
      { logsBefore: 1.5 },
      { logsLimit: 0 },
      { stepsLimit: -1 },
    ]) {
      const { pool, stmts, counters } = makeDb({ ...logDb(3) });
      await expect(getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE, opts)).rejects.toMatchObject({
        code: 'bad_request',
      });
      expect(stmts).toHaveLength(0);
      expect(counters.connects).toBe(0);
    }
  });

  it('still rolls back and releases the client when COMMIT itself throws', async () => {
    const { pool, stmts, counters } = makeDb({ failCommit: true, ...logDb(5) });

    await expect(getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE)).rejects.toThrow('connection lost');
    // The failed COMMIT is followed by a best-effort ROLLBACK, and the client
    // is released on every path.
    expect(stmts.map((s) => s.sql)).toContain('ROLLBACK');
    expect(counters.releases).toBe(1);
  });

  it('clamps an oversized page size to MAX_DETAIL_PAGE (5000)', async () => {
    const { pool, stmts } = makeDb(logDb(20));

    await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE, { logsLimit: 99_999 });

    // 5000 kept + 1 probe row = the LIMIT that reaches pg.
    const logsStmt = stmts.find((s) => /FROM logs/.test(s.sql));
    expect(logsStmt?.params[logsStmt.params.length - 1]).toBe(5001);
  });
});

describe('getRunDetail — logs pagination', () => {
  it('default page = the NEWEST 200 lines, ascending (chronological), with a cursor', async () => {
    const { pool } = makeDb(logDb(1200));

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.logs).toHaveLength(200);
    expect(detail.logs[0]!.id).toBe(1001);
    expect(detail.logs[199]!.id).toBe(1200);
    // Ascending ids = chronological display.
    for (let i = 1; i < detail.logs.length; i++) {
      expect(detail.logs[i]!.id).toBeGreaterThan(detail.logs[i - 1]!.id);
    }
    // The oldest line of the page doubles as the backward cursor.
    expect(detail.logsNextCursor).toBe(1001);
  });

  it('a 1200-line run pages back to the start via logsBefore (200 per page)', async () => {
    const { pool } = makeDb(logDb(1200));

    const seen: number[] = [];
    let cursor: number | undefined;
    let pages = 0;
    for (;;) {
      const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE, {
        ...(cursor !== undefined ? { logsBefore: cursor } : {}),
      });
      seen.push(...detail.logs.map((l) => l.id));
      pages += 1;
      if (detail.logsNextCursor === null) break;
      cursor = detail.logsNextCursor;
    }

    // Six full pages, every line exactly once, ids ascending within each page.
    expect(pages).toBe(6);
    expect(seen).toHaveLength(1200);
    expect(new Set(seen).size).toBe(1200);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(1200);
  });

  it('a page with no older rows returns logsNextCursor null (even on the first page)', async () => {
    const { pool } = makeDb(logDb(150)); // fewer than one page

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.logs).toHaveLength(150);
    expect(detail.logs[0]!.id).toBe(1);
    expect(detail.logs[149]!.id).toBe(150);
    expect(detail.logsNextCursor).toBe(null);
  });

  it('exactly one page of logs (200) has no cursor', async () => {
    const { pool } = makeDb(logDb(200));

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.logs).toHaveLength(200);
    expect(detail.logs[0]!.id).toBe(1);
    expect(detail.logs[199]!.id).toBe(200);
    expect(detail.logsNextCursor).toBe(null);
  });

  it('an exactly-full second page (400 logs) terminates the walk with null', async () => {
    const { pool } = makeDb(logDb(400));

    const first = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);
    expect(first.logs).toHaveLength(200);
    expect(first.logs[0]!.id).toBe(201);
    expect(first.logsNextCursor).toBe(201);

    // logsBefore=201 has exactly 200 older rows — a full page, and the last.
    const second = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE, { logsBefore: 201 });
    expect(second.logs).toHaveLength(200);
    expect(second.logs[0]!.id).toBe(1);
    expect(second.logs[199]!.id).toBe(200);
    expect(second.logsNextCursor).toBe(null);
  });

  it('an empty run has no logs and no cursor', async () => {
    const { pool } = makeDb(logDb(0));

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.logs).toEqual([]);
    expect(detail.logsNextCursor).toBe(null);
  });

  it('an explicit logsLimit sizes the page', async () => {
    const { pool } = makeDb(logDb(1200));

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE, { logsLimit: 500 });

    expect(detail.logs).toHaveLength(500);
    expect(detail.logs[0]!.id).toBe(701);
    expect(detail.logs[499]!.id).toBe(1200);
    expect(detail.logsNextCursor).toBe(701);
  });
});

describe('getRunDetail — steps/waits caps', () => {
  it('keeps the newest 500 steps and flags the cut', async () => {
    const { pool } = makeDb({ steps: range(0, 501).map(stepRow) });

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.steps).toHaveLength(500);
    expect(detail.stepsTruncated).toBe(true);
    // Newest kept (the 0th is the cut one), ascending by seq for display.
    expect(detail.steps[0]!.seq).toBe(1);
    expect(detail.steps[499]!.seq).toBe(500);
    for (let i = 1; i < detail.steps.length; i++) {
      expect(detail.steps[i]!.seq).toBeGreaterThan(detail.steps[i - 1]!.seq);
    }
  });

  it('keeps the newest 500 waits and flags the cut', async () => {
    const { pool } = makeDb({ waits: range(1, 501).map(waitRow) });

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.waits).toHaveLength(500);
    expect(detail.waitsTruncated).toBe(true);
    expect(detail.waits[0]!.id).toBe(2);
    expect(detail.waits[499]!.id).toBe(501);
  });

  it('no truncated flags when under the caps', async () => {
    const { pool } = makeDb({ steps: range(0, 3).map(stepRow), waits: range(1, 2).map(waitRow) });

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.steps).toHaveLength(3);
    expect(detail.stepsTruncated).toBe(false);
    expect(detail.waits).toHaveLength(2);
    expect(detail.waitsTruncated).toBe(false);
  });
});

describe('getRunDetail — shape', () => {
  it('maps rows to the wire types (camelCase, ISO dates, nulls preserved)', async () => {
    const { pool } = makeDb({
      steps: range(0, 2).map(stepRow),
      waits: range(1, 1).map(waitRow),
      logs: range(1, 2).map(logRow),
    });

    const detail = await getRunDetail(pool, 'run_1', DEFAULT_NAMESPACE);

    expect(detail.run.id).toBe('run_1');
    expect(detail.run.status).toBe('running');
    expect(detail.run.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(detail.run.startedAt).toBe('2026-08-01T00:00:01.000Z');
    expect(detail.run.finishedAt).toBe(null);

    expect(detail.steps[0]).toMatchObject({ seq: 0, label: 'step-0', status: 'completed' });
    expect(detail.steps[0]!.startedAt).toBe(new Date(1_752_480_000_000).toISOString());

    expect(detail.waits[0]).toMatchObject({ id: 1, stepSeq: 1, kind: 'duration', status: 'completed' });
    expect(detail.logs[0]).toMatchObject({ id: 1, message: 'line 1', level: 'info' });
    expect(detail.logs[0]!.ts).toBe(new Date(1_752_480_000_001).toISOString());
  });
});
