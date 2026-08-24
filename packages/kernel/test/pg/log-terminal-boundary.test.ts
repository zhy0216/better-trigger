/* =============================================================================
   @better-trigger/kernel — strict log/terminal boundary (p2-40).

   appendLogs used one `INSERT ... WHERE EXISTS (... finished_at IS NULL)`
   statement per chunk. A concurrent terminal tx could commit between that
   statement's snapshot and its FK check on logs.run_id: the INSERT then
   blocked on the run row (key-share vs FOR UPDATE), the terminal tx committed,
   and the INSERT resumed — a log line committed AFTER finished_at. The fix
   gives every chunk its own short transaction that locks the run row first
   (`SELECT finished_at ... FOR UPDATE`), inserts only under a NULL finished_at
   and commits. Append and terminal are now linearized on the run row lock:
   the winner of the lock decides whether the lines are pre-terminal; the loser
   drops them (0 rows, no error, one `[runs:logs]` warn).

   This suite runs against real Postgres (skipped without DATABASE_URL) so the
   lock ordering itself — not just the SQL text — is what gets asserted. The
   core test directly controls the commit order of two connections: a terminal
   UPDATE holds the run row uncommitted, appendLogs blocks behind it, the
   terminal commits, and the append must land NOTHING. If the implementation
   ever regressed to the snapshot-then-FK-wait shape, that sequence would
   produce a log row after the terminal commit and fail here.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { expect, it } from 'vitest';
import type { LogEntry, Namespace } from '@better-trigger/core';
import { appendLogs } from '../../src/runs';
import type { KernelLogger } from '../../src/kernel';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const ACME = { projectId: 'acme', env: 'prod' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const entry = (message: string, i = 0): LogEntry => ({
  ts: new Date(Date.now() + i).toISOString(),
  level: 'info',
  message,
});

const entries = (n: number): LogEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`line ${i}`, i));

/** A warn-capturing kernel logger, matching KernelLogger's shape. */
function captureLogger(): { logger: KernelLogger; warns: string[] } {
  const warns: string[] = [];
  const logger: KernelLogger = {
    warn: (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    },
    error: () => {},
  };
  return { logger, warns };
}

/** Insert a run row already 'running' (direct SQL — fastest per-round setup). */
async function insertRunningRun(pool: Pool, runId: string, ns: Namespace = NS): Promise<void> {
  await pool.query(
    `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type)
     VALUES ($1, $2, $3, 'log-boundary-task', 'running', 'api')`,
    [runId, ns.projectId, ns.env],
  );
}

async function countLogs(pool: Pool, runId: string, ns: Namespace = NS): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM logs WHERE run_id = $1 AND project_id = $2 AND env = $3`,
    [runId, ns.projectId, ns.env],
  );
  return res.rows[0]!.n;
}

async function runStatus(pool: Pool, runId: string): Promise<string> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM runs WHERE id = $1`,
    [runId],
  );
  return res.rows[0]!.status;
}

/** The exact lock-SELECT text appendLogs issues, for pg_stat_activity. */
const LOCK_SELECT_TEXT =
  'SELECT finished_at FROM runs WHERE id = $1 AND project_id = $2 AND env = $3 FOR UPDATE';

/**
 * Poll until some backend is blocked (state 'active' with a wait event) on a
 * query matching `pattern`. The blocked state is the proof that the query
 * reached the contested lock BEFORE the lock holder committed — the whole
 * point of a commit-order assertion.
 */
async function waitForBlocked(pool: Pool, pattern: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const blocked = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE query LIKE $1 AND state = 'active' AND wait_event IS NOT NULL`,
      [pattern],
    );
    if (blocked.rows[0]!.n > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`${label}: expected a backend to block on ${pattern}, none did`);
    }
    await sleep(5);
  }
}

/** End a held tx no matter its state, then hand the client back. */
async function closeHeldTx(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => {});
  await client.release();
}

describePg('log terminal boundary (p2-40)', () => {
  it('a running run absorbs a flush; the history stays intact after it goes terminal', async () => {
    await withPg('log_boundary_normal', async ({ kernel, pool }) => {
      await insertRunningRun(pool, 'normal-1');
      const { logger, warns } = captureLogger();

      await appendLogs(pool, 'normal-1', NS, entries(3), logger);
      expect(await countLogs(pool, 'normal-1')).toBe(3);
      expect(warns).toHaveLength(0);

      await pool.query(
        `UPDATE runs SET status = 'completed', finished_at = now() WHERE id = 'normal-1'`,
      );
      // The lines written before the boundary are the run's history — they stay.
      expect(await countLogs(pool, 'normal-1')).toBe(3);

      // The public kernel surface also writes (wiring check).
      await kernel.appendLogs('normal-1', NS, entries(1));
      expect(await countLogs(pool, 'normal-1')).toBe(3);
    });
  });

  it('a missing run absorbs nothing, raises nothing, and the drop is observable', async () => {
    await withPg('log_boundary_missing', async ({ pool }) => {
      const { logger, warns } = captureLogger();
      await expect(
        appendLogs(pool, 'no-such-run', NS, entries(2), logger),
      ).resolves.toBeUndefined();
      expect(await countLogs(pool, 'no-such-run')).toBe(0);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/\[runs:logs\] dropped 2 log line\(s\): run no-such-run .*does not exist/);
    });
  });

  it('an already-terminal run absorbs nothing and the drop is logged as terminal, not missing', async () => {
    await withPg('log_boundary_terminal', async ({ pool }) => {
      await insertRunningRun(pool, 'done-1');
      await pool.query(
        `UPDATE runs SET status = 'failed', finished_at = now() WHERE id = 'done-1'`,
      );
      const { logger, warns } = captureLogger();

      await expect(appendLogs(pool, 'done-1', NS, entries(4), logger)).resolves.toBeUndefined();
      expect(await countLogs(pool, 'done-1')).toBe(0);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/already terminal/);
    });
  });

  it('the lock SELECT is namespace-scoped: a foreign namespace is "not found" (C2)', async () => {
    await withPg('log_boundary_namespace', async ({ pool }) => {
      await insertRunningRun(pool, 'ns-run', ACME);
      const { logger, warns } = captureLogger();

      await appendLogs(pool, 'ns-run', NS, entries(2), logger);
      expect(await countLogs(pool, 'ns-run', ACME)).toBe(0);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/does not exist/);

      // Its own namespace still absorbs.
      await appendLogs(pool, 'ns-run', ACME, entries(2), logger);
      expect(await countLogs(pool, 'ns-run', ACME)).toBe(2);
    });
  });

  it('concurrent flushes on the same live run all land — the per-chunk lock only serializes, never loses', async () => {
    await withPg('log_boundary_concurrent', async ({ pool }) => {
      await insertRunningRun(pool, 'conc-1');
      const { logger, warns } = captureLogger();

      await Promise.all([
        appendLogs(pool, 'conc-1', NS, entries(100), logger),
        appendLogs(pool, 'conc-1', NS, entries(100), logger),
      ]);
      expect(await countLogs(pool, 'conc-1')).toBe(200);
      expect(warns).toHaveLength(0);
    });
  });

  it('a multi-chunk flush (2500 lines) lands every line — one lock per chunk, not one long tx', async () => {
    await withPg('log_boundary_chunks', async ({ pool }) => {
      await insertRunningRun(pool, 'bulk-1');
      const { logger, warns } = captureLogger();

      await appendLogs(pool, 'bulk-1', NS, entries(2500), logger);
      expect(await countLogs(pool, 'bulk-1')).toBe(2500);
      expect(warns).toHaveLength(0);
    });
  });

  it('deleting a run still cascades its logs (the INSERT no longer rides an EXISTS guard)', async () => {
    await withPg('log_boundary_cascade', async ({ pool }) => {
      await insertRunningRun(pool, 'casc-1');
      await appendLogs(pool, 'casc-1', NS, entries(5));
      expect(await countLogs(pool, 'casc-1')).toBe(5);

      await pool.query(`DELETE FROM runs WHERE id = 'casc-1'`);
      expect(await countLogs(pool, 'casc-1')).toBe(0);
    });
  });

  it('a run that goes terminal mid-flush absorbs only chunks locked before the boundary', async () => {
    await withPg('log_boundary_midflush', async ({ pool }) => {
      await insertRunningRun(pool, 'mid-1');
      const { logger, warns } = captureLogger();

      // 2500 lines = 3 chunks. Wait until the first chunk is committed, then
      // force the terminal — chunk 2/3 land or drop depending on who wins the
      // row lock, but NOTHING may land after finished_at exists.
      const append = appendLogs(pool, 'mid-1', NS, entries(2500), logger);
      const deadline = Date.now() + 10_000;
      while ((await countLogs(pool, 'mid-1')) < 1000) {
        if (Date.now() > deadline) throw new Error('first chunk never landed');
        await sleep(5);
      }
      await pool.query(
        `UPDATE runs SET status = 'completed', finished_at = now() WHERE id = 'mid-1'`,
      );
      await append;

      const final = await countLogs(pool, 'mid-1');
      // The legal outcome set under the strict boundary: the terminal landed
      // before chunk 2 (1000), before chunk 3 (2000) or after all of them
      // (3000 — every chunk got its lock first, so every line is pre-terminal).
      expect([1000, 2000, 3000]).toContain(final);
      const terminalWarns = warns.filter((w) => w.includes('already terminal'));
      if (final < 3000) {
        expect(terminalWarns).toHaveLength(1);
        expect(terminalWarns[0]).toMatch(new RegExp(`dropped ${2500 - final} log line`));
      } else {
        expect(terminalWarns).toHaveLength(0);
      }
    });
  });

  it('terminal/append interleave, terminal first: an append blocked behind an uncommitted terminal lands NOTHING (100 rounds)', async () => {
    await withPg('log_boundary_interleave_drop', async ({ pool }) => {
      for (let i = 0; i < 100; i++) {
        const runId = `race-drop-${i}`;
        await insertRunningRun(pool, runId);

        const terminal = await pool.connect();
        try {
          await terminal.query('BEGIN');
          await terminal.query(
            `UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1`,
            [runId],
          );

          // The append is doomed to block on the run row lock until the
          // terminal tx commits — which is exactly the window the old
          // snapshot-then-FK-wait shape would have smuggled a line through.
          const { logger, warns } = captureLogger();
          const append = appendLogs(pool, runId, NS, entries(3), logger);
          await waitForBlocked(pool, `${LOCK_SELECT_TEXT}%`, `round ${i}: append never blocked`);

          // Blocked behind an uncommitted terminal: nothing may have landed.
          expect(await countLogs(pool, runId)).toBe(0);

          await terminal.query('COMMIT');
          await append;

          // After the terminal commit the append resolved with ZERO rows — the
          // commit-order invariant: no log row ever appears after finished_at.
          expect(await countLogs(pool, runId)).toBe(0);
          expect(await runStatus(pool, runId)).toBe('completed');
          expect(warns).toHaveLength(1);
          expect(warns[0]).toMatch(/already terminal/);
        } finally {
          await closeHeldTx(terminal);
        }
      }
    });
  });

  it('terminal/append interleave, append first: the terminal write blocks behind the in-flight append and the pre-terminal lines survive (25 rounds)', async () => {
    await withPg('log_boundary_interleave_keep', async ({ pool }) => {
      for (let i = 0; i < 25; i++) {
        const runId = `race-keep-${i}`;
        await insertRunningRun(pool, runId);

        const app = await pool.connect();
        try {
          await app.query('BEGIN');
          // The same lock a real append chunk takes, plus its INSERT, held
          // open to make the interleave deterministic.
          await app.query(LOCK_SELECT_TEXT, [runId, NS.projectId, NS.env]);
          await app.query(
            `INSERT INTO logs (project_id, env, run_id, step_seq, level, message, data, ts)
             VALUES ($1, $2, $3, NULL, 'info', 'pre-terminal', NULL, now())`,
            [NS.projectId, NS.env, runId],
          );

          // The terminal UPDATE must wait for the row lock — proving the
          // terminal side is only ever delayed by the in-flight INSERT.
          const terminal = await pool.connect();
          try {
            await terminal.query('BEGIN');
            const terminalUpdate = terminal.query(
              `UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1`,
              [runId],
            );
            await waitForBlocked(
              pool,
              `UPDATE runs SET status = 'completed', finished_at = now()%`,
              `round ${i}: terminal never blocked`,
            );

            // The line committed strictly before the terminal: it is part of
            // the run's history and must survive.
            await app.query('COMMIT');
            await terminalUpdate;
            await terminal.query('COMMIT');
          } finally {
            await closeHeldTx(terminal);
          }

          expect(await countLogs(pool, runId)).toBe(1);
          expect(await runStatus(pool, runId)).toBe('completed');
        } finally {
          await closeHeldTx(app);
        }
      }
    });
  });

  it('the real kernel terminal op is serialized against the append lock the same way', async () => {
    await withPg('log_boundary_kernel_complete', async ({ kernel, pool }) => {
      const { workerId } = await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [NS],
        tasks: [{ id: 'log-boundary-task', codeVersion: 'v1' }],
      });
      const { runId } = await kernel.trigger({ taskId: 'log-boundary-task', payload: {}, namespace: NS });
      const claimed = await kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: ['log-boundary-task'],
        leaseMs: 60_000,
        limit: 1,
      });
      expect(claimed[0]!.id).toBe(runId);

      const app = await pool.connect();
      try {
        await app.query('BEGIN');
        await app.query(LOCK_SELECT_TEXT, [runId, NS.projectId, NS.env]);
        await app.query(
          `INSERT INTO logs (project_id, env, run_id, step_seq, level, message, data, ts)
           VALUES ($1, $2, $3, NULL, 'info', 'just before complete', NULL, now())`,
          [NS.projectId, NS.env, runId],
        );

        const completing = kernel.completeRun({
          runId,
          output: { ok: true },
          workerId,
          fencingToken: claimed[0]!.fencingToken,
          namespace: NS,
        });
        // completeRun's lockRunRow (canonical position 2) blocks behind the
        // append's held lock; committing the append releases it.
        await waitForBlocked(
          pool,
          `%FROM runs WHERE id = $1 AND project_id = $2 AND env = $3 FOR UPDATE%`,
          'completeRun never blocked on the run row',
        );
        await app.query('COMMIT');
        await completing;

        expect(await countLogs(pool, runId)).toBe(1);
        expect(await runStatus(pool, runId)).toBe('completed');
      } finally {
        await closeHeldTx(app);
      }
    });
  });
});
