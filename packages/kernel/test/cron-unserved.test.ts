/* =============================================================================
   @better-trigger/kernel — p2-18 C1: cron fires for tasks no online worker
   serves are skipped, not turned into forever-queued runs.

   A task removed from every online worker's manifest keeps its `tasks` row
   AND its schedule (the engine never deletes a task), so the due-scan still
   finds it due every cycle. Pre-fix, each such tick created a run no worker
   could claim — unbounded queued rows, fully silent under the default config
   (the stranded scan only runs under pinning). The loop now partitions the
   due rows against the live worker manifests: served ones fire as always;
   unserved ones only advance next_run_at (DB-clock discipline, same clamp as
   the fire path — the schedule keeps its cadence and cannot monopolize the
   LIMIT window), counted on the handle and named by a transition log.

   Pinned against a stub client (no Postgres): which path a due row takes,
   what gets written for it, and what gets counted/logged. The end-to-end
   behaviour on a real database is test/pg/cron-unserved.test.ts.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';

interface Stmt {
  sql: string;
  params: unknown[];
}

/** Placeholder/param alignment: max $N must equal param count, every $1..$N
 *  present (same helper as namespace-isolation.test.ts). */
function expectAligned(sql: string, params: unknown[]): void {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = Math.max(0, ...nums);
  expect(max, `placeholder max ${max} ≠ ${params.length} params in:\n${sql}`).toBe(
    params.length,
  );
  for (let i = 1; i <= max; i++) {
    expect(nums, `placeholder $${i} missing in:\n${sql}`).toContain(i);
  }
}

/**
 * A stub cron tick: the due-scan finds one `ghost` schedule (default/prod),
 * served once so exactly one tick walks the partition. `served` answers the
 * worker-manifest check — empty for the unserved case, ['ghost'] for the
 * fire-anyway case. INSERT INTO runs is answered with a row so the served
 * path can complete through createRunIn.
 */
function cronPool(served: string[]) {
  const stmts: Stmt[] = [];
  let dueServed = false;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM schedules\s+WHERE enabled/.test(sql)) {
        if (dueServed) return { rows: [] };
        dueServed = true;
        return {
          rows: [
            {
              id: 'sch_1',
              task_id: 'ghost',
              cron_pattern: '*/5 * * * *',
              cron_tz: 'UTC',
              project_id: 'default',
              env: 'prod',
              db_now: new Date(),
            },
          ],
        };
      }
      if (/unnest\(\$2::text\[\]\) AS task_id/.test(sql)) {
        const ids = params[1] as string[];
        return { rows: ids.filter((id) => served.includes(id)).map((task_id) => ({ task_id })) };
      }
      if (/INSERT INTO runs/.test(sql)) return { rows: [{ id: 'run_new' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  } as unknown as Pool;
  return { pool, stmts };
}

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    },
  };
}

const CRON_ONLY = {
  waits: false,
  reaper: false,
  workerOffline: false,
  cronIntervalMs: 20,
} as const;

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('scanCron — unserved schedule skip (p2-18 C1)', () => {
  it('skips the fire, advances next_run_at without touching last_run_*, counts and logs it', async () => {
    const { pool, stmts } = cronPool([]);
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, CRON_ONLY);
    try {
      await waitFor(() => stmts.some((s) => s.sql === 'COMMIT'));
      await waitFor(() => handle.counters.cronSkippedUnserved > 0);
    } finally {
      handle.stop();
    }

    // The due row was checked against the live worker set, in its own
    // namespace, for exactly its task id.
    const servedCheck = stmts.find((s) => /unnest\(\$2::text\[\]\) AS task_id/.test(s.sql))!;
    expect(servedCheck).toBeDefined();
    expect(servedCheck.params[0]).toBe('[{"projectId":"default","env":"prod"}]');
    expect(servedCheck.params[1]).toEqual(['ghost']);
    // "Served" is the registration guard's reading (workers.ts): online AND
    // heartbeating inside the offline-marker window AND namespace-scoped,
    // with both manifest shapes (pair / legacy bare id) normalized.
    expect(servedCheck.sql).toMatch(/w\.status = 'online'/);
    expect(servedCheck.sql).toMatch(/w\.last_heartbeat_at > now\(\) - INTERVAL '2 minutes'/);
    expect(servedCheck.sql).toMatch(/w\.namespaces @> \$1::jsonb/);
    expect(servedCheck.sql).toMatch(/COALESCE\(e->>'id', e #>> '\{\}'\) = t\.task_id/);
    expectAligned(servedCheck.sql, servedCheck.params);

    // No run was created, and no `work` wake either (that would be noise —
    // nothing claimable happened).
    expect(stmts.some((s) => /INSERT INTO runs/.test(s.sql))).toBe(false);
    expect(stmts.some((s) => /pg_notify/.test(s.sql))).toBe(false);

    // The schedule advanced WITHOUT last_run_at / last_run_id: nothing ran.
    // Same DB-clock clamp + NULL guard as the fire path (p1-09).
    const advance = stmts.find(
      (s) => /UPDATE schedules/.test(s.sql) && /next_run_at = CASE/.test(s.sql),
    )!;
    expect(advance).toBeDefined();
    expect(advance.sql).not.toMatch(/last_run_at/);
    expect(advance.sql).not.toMatch(/last_run_id/);
    expect(advance.sql).toMatch(/GREATEST\(\$2::timestamptz, now\(\) \+ interval '1 second'\)/);
    expect(advance.params[0]).toBe('sch_1');
    expect(advance.params[1]).toBeInstanceOf(Date);
    expect(advance.params[2]).toBe('default');
    expect(advance.params[3]).toBe('prod');
    expectAligned(advance.sql, advance.params);

    // Counted, and named by the transition log.
    expect(handle.counters.cronSkippedUnserved).toBeGreaterThanOrEqual(1);
    expect(handle.counters.loopErrors.cron).toBe(0);
    const skipLine = lines.find((l) => l.includes('skipped due cron fire'));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain('default/prod/ghost');
    expect(skipLine).toContain('no online');
  }, 10_000);

  it('still fires when an online worker serves the task (correct path unchanged)', async () => {
    const { pool, stmts } = cronPool(['ghost']);
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, CRON_ONLY);
    try {
      await waitFor(() => stmts.some((s) => s.sql === 'COMMIT'));
      // Give a mis-partitioned skip the chance to appear.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      handle.stop();
    }

    // createRunIn ran for the served schedule…
    expect(stmts.some((s) => /INSERT INTO runs/.test(s.sql))).toBe(true);
    // …and the write-back is the fire path's (last_run_* set), not the skip's.
    const writeBack = stmts.find(
      (s) => /UPDATE schedules/.test(s.sql) && /last_run_at = now\(\)/.test(s.sql),
    )!;
    expect(writeBack).toBeDefined();
    expect(handle.counters.cronSkippedUnserved).toBe(0);
    expect(lines.some((l) => l.includes('skipped due cron fire'))).toBe(false);
    expect(handle.counters.loopErrors.cron).toBe(0);
  }, 10_000);
});
