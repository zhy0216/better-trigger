/* =============================================================================
   @better-trigger/kernel — 04-T1: one poisoned cron schedule must not stall
   the whole scheduler.

   scanCron runs one transaction over every due schedule of the tick; the
   next-fire computation (nextCronAt) THROWS on a pattern/timezone that no
   longer parses. Registration validates both, so a stored row only turns
   poisonous from outside it (a dashboard/manual edit of
   schedules.cron_pattern/cron_tz, a croner upgrade, tz-data renaming a zone)
   — and pre-isolation that throw rolled the whole tick back, leaving EVERY
   due schedule's next_run_at stale, so the entire namespace's cron re-fired
   nothing forever while only loopErrors.cron said anything was wrong.

   Pinned against a stub client (no Postgres): the poisoned row is isolated
   (quarantined to next_run_at NULL, counted, named by a warn) while the
   healthy rows of the SAME batch still fire and advance, and the transaction
   COMMITs instead of rolling back. The end-to-end behaviour on a real
   database is test/pg/cron-poison.test.ts.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';

interface Stmt {
  sql: string;
  params: unknown[];
}

interface DueSchedule {
  id: string;
  task_id: string;
  cron_pattern: string;
  cron_tz: string | null;
}

/** Placeholder/param alignment: max $N must equal param count, every $1..$N
 *  present (same helper as cron-unserved.test.ts). */
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
 * A stub cron tick whose due-scan finds ALL given schedules (default/prod),
 * served once so exactly one tick walks the batch. Every task id is answered
 * as served unless `served` says otherwise, so the poison isolation (not the
 * unserved partition) decides each row's fate. INSERT INTO runs answers a row
 * per fire.
 */
function cronPool(schedules: DueSchedule[], served: string[] | 'all') {
  const stmts: Stmt[] = [];
  let dueServed = false;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM schedules\s+WHERE enabled/.test(sql)) {
        if (dueServed) return { rows: [] };
        dueServed = true;
        return {
          rows: schedules.map((s) => ({
            ...s,
            project_id: 'default',
            env: 'prod',
            db_now: new Date(),
          })),
        };
      }
      if (/unnest\(\$2::text\[\]\) AS task_id/.test(sql)) {
        const ids = params[1] as string[];
        const servedSet = served === 'all' ? ids : served;
        return { rows: ids.filter((id) => servedSet.includes(id)).map((task_id) => ({ task_id })) };
      }
      if (/INSERT INTO runs/.test(sql)) return { rows: [{ id: 'run_new' }], rowCount: 1 };
      // createRunIn's database-clock read (T1): same tx ⇒ same now() the
      // due-scan carried as db_now.
      if (/^SELECT now\(\)/.test(sql)) return { rows: [{ now: new Date() }], rowCount: 1 };
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

const HEALTHY: DueSchedule = {
  id: 'sch_healthy',
  task_id: 'healthy',
  cron_pattern: '*/5 * * * *',
  cron_tz: 'UTC',
};
const POISON: DueSchedule = {
  id: 'sch_poison',
  task_id: 'poisoned',
  cron_pattern: 'not a cron',
  cron_tz: 'UTC',
};

describe('scanCron — poisoned schedule isolation (04-T1)', () => {
  it('a poisoned schedule is quarantined while the healthy one in the same batch still fires', async () => {
    const { pool, stmts } = cronPool([POISON, HEALTHY], 'all');
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, CRON_ONLY);
    try {
      await waitFor(() => handle.counters.cronPoisoned > 0);
    } finally {
      handle.stop();
    }

    // The tick COMMITTED — the poison did not roll the shared transaction
    // back (that is what used to stall every due schedule forever).
    expect(stmts.some((s) => s.sql === 'COMMIT')).toBe(true);
    expect(stmts.some((s) => s.sql === 'ROLLBACK')).toBe(false);
    expect(handle.counters.loopErrors.cron).toBe(0);

    // Both schedules were served, so BOTH fired their legitimately-due run —
    // the quarantine starts AFTER the fire, not instead of it.
    const inserts = stmts.filter((s) => /INSERT INTO runs/.test(s.sql));
    expect(inserts).toHaveLength(2);

    // The write-backs: the healthy schedule advanced to its next fire, the
    // poisoned one recorded its fire (last_run_*) but went next_run_at NULL —
    // the impossible-pattern treatment, silent until the pattern is fixed.
    const writeBacks = stmts.filter(
      (s) => /UPDATE schedules/.test(s.sql) && /last_run_at = now\(\)/.test(s.sql),
    );
    expect(writeBacks).toHaveLength(2);
    const healthyWrite = writeBacks.find((s) => s.params[0] === HEALTHY.id)!;
    const poisonWrite = writeBacks.find((s) => s.params[0] === POISON.id)!;
    expect(healthyWrite.params[2]).toBeInstanceOf(Date);
    expect(poisonWrite.params[2]).toBeNull();
    expectAligned(healthyWrite.sql, healthyWrite.params);
    expectAligned(poisonWrite.sql, poisonWrite.params);

    // Counted and named; the healthy schedule is not dragged into the report.
    expect(handle.counters.cronPoisoned).toBe(1);
    expect(handle.counters.cronSkippedUnserved).toBe(0);
    const warn = lines.find((l) => l.includes('no longer parses'));
    expect(warn).toBeDefined();
    expect(warn).toContain(POISON.id);
    expect(warn).toContain('default/prod/poisoned');
    expect(warn).toContain('not a cron');
    expect(warn).toContain('next_run_at set to NULL');
    expect(lines.some((l) => l.includes(HEALTHY.id))).toBe(false);
  }, 10_000);

  it('an UNSERVED poisoned schedule is quarantined without creating a run', async () => {
    // Poisoned AND unserved: the skip path's write-back carries no
    // last_run_* — here it must also carry the NULL quarantine.
    const { pool, stmts } = cronPool([POISON, HEALTHY], [HEALTHY.task_id]);
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, CRON_ONLY);
    try {
      await waitFor(() => handle.counters.cronPoisoned > 0);
    } finally {
      handle.stop();
    }

    expect(stmts.some((s) => s.sql === 'COMMIT')).toBe(true);
    expect(handle.counters.loopErrors.cron).toBe(0);
    // Only the healthy (served) schedule created a run.
    expect(stmts.filter((s) => /INSERT INTO runs/.test(s.sql))).toHaveLength(1);

    // The poison went through the SKIP write-back shape (no last_run_*) with
    // a NULL next: quarantined silent, no fire.
    const skipWrite = stmts.find(
      (s) =>
        /UPDATE schedules/.test(s.sql) &&
        !/last_run_at/.test(s.sql) &&
        s.params[0] === POISON.id,
    )!;
    expect(skipWrite).toBeDefined();
    expect(skipWrite.params[1]).toBeNull();
    expectAligned(skipWrite.sql, skipWrite.params);

    expect(handle.counters.cronPoisoned).toBe(1);
    expect(handle.counters.cronSkippedUnserved).toBe(1);
    expect(lines.some((l) => l.includes('no longer parses') && l.includes(POISON.id))).toBe(true);
  }, 10_000);

  it('an unknown timezone poisons the same way as a bad pattern', async () => {
    const badTz: DueSchedule = {
      id: 'sch_tz',
      task_id: 'tz-poisoned',
      cron_pattern: '0 9 * * *',
      cron_tz: 'Mars/Olympus_Mons',
    };
    const { pool } = cronPool([badTz, HEALTHY], 'all');
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, CRON_ONLY);
    try {
      await waitFor(() => handle.counters.cronPoisoned > 0);
    } finally {
      handle.stop();
    }

    expect(handle.counters.loopErrors.cron).toBe(0);
    expect(handle.counters.cronPoisoned).toBe(1);
    expect(lines.some((l) => l.includes('no longer parses') && l.includes('sch_tz'))).toBe(true);
  }, 10_000);
});
