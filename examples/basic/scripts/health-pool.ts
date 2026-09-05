/* =============================================================================
   @better-trigger/example-basic — health/metrics probe pool e2e
   (todos/02-performance.md PF4).

   The unit tests around the probe pool assert configuration and stub
   behaviour; they cannot tell whether a real Postgres honours any of it. This
   scenario proves it on a live database:

     a. createHealthPool's statement_timeout is *server-side* effective: the
        setting read back through pg_settings on a connection from the pool is
        1000ms, not just a value in pool.options.
     b. a probe that never returns is cancelled by statement_timeout at ~1s
        with SQLSTATE 57014 (query_canceled), and the connection returns to
        the pool: consecutive probes keep completing at ~1s each instead of
        exhausting max=2 (a leaked connection would leave the third probe
        queued forever), and a plain SELECT 1 still works afterwards.
     c. pool-level concurrency: concurrent probes queue through max=2 without
        losing work — 6 × pg_sleep(0.3) all succeed in ~2 batches, not 6
        sequential sleeps.
     d. daemon-level single-flight: an API-only daemon with a real
        createHealthPool; the gauge query is blocked server-side (LOCK TABLE
        queue), 10 concurrent /metrics scrapes all answer within ~1s because
        they share ONE blocked query that statement_timeout cancels — without
        the guard they would queue on the max=2 pool and hit their own 2s HTTP
        deadlines in waves (~5s+). After the lock is released the same scrape
        sees db_up 1 again, and concurrent deep /health?deep=1 probes stay
        fast.

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_HEALTH_POOL_DB override the database name prefix (default
                       better_trigger_health_pool)
   ============================================================================= */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createHealthPool } from '@better-trigger/db';
import {
  runScenario,
  spawnDaemon,
  waitForHealth,
  type Scenario,
} from '@better-trigger/testing';

/** An OS-assigned port, released before the daemon is handed it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** Reject if `p` has not settled within `ms` — a hang must fail, not stall. */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${what}: hung longer than ${ms}ms`)), ms);
    }),
  ]);
}

/** `SHOW statement_timeout`-style value → milliseconds ('1s' → 1000). */
function timeoutMs(setting: string, unit: string | null): number {
  if (unit === 'ms') return Number(setting);
  const m = /^(\d+)(ms|s)$/.exec(setting);
  if (!m) throw new Error(`unparseable timeout value: ${JSON.stringify(setting)}${unit ? ` ${unit}` : ''}`);
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

async function main(s: Scenario): Promise<void> {
  /* -- a. statement_timeout is server-side effective ---------------------- */
  await s.check('createHealthPool sets statement_timeout=1000 on the server', async () => {
    const pool = createHealthPool(s.db.url, { error: () => {} });
    try {
      const client = await withDeadline(pool.connect(), 10_000, 'connect');
      try {
        const res = await client.query<{ setting: string; unit: string | null }>(
          `SELECT setting, unit FROM pg_settings WHERE name = 'statement_timeout'`,
        );
        const row = res.rows[0];
        s.assert(row !== undefined, 'pg_settings has a statement_timeout row');
        const ms = timeoutMs(row.setting, row.unit);
        s.assertEqual(ms, 1000, 'statement_timeout on a probe-pool connection');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  /* -- b. a never-returning probe is cancelled at ~1s; connections return --- */
  await s.check('a hung probe is cancelled server-side (57014) and the connection returns', async () => {
    const pool = createHealthPool(s.db.url, { error: () => {} });
    try {
      for (let i = 0; i < 4; i++) {
        const started = Date.now();
        let code: string | null = null;
        try {
          // A 30s sleep is "never returns" for a probe. If statement_timeout
          // were not effective this would take 30s (and trip the deadline);
          // if the cancelled connection leaked, probe 3 would queue forever
          // behind max=2 (and trip the deadline too).
          await withDeadline(pool.query('SELECT pg_sleep(30)'), 10_000, `probe ${i}`);
          s.fail(`probe ${i}: pg_sleep(30) completed — statement_timeout did not fire`);
        } catch (err) {
          code = (err as { code?: string }).code ?? null;
        }
        const elapsed = Date.now() - started;
        s.assertEqual(code, '57014', `probe ${i} cancelled with query_canceled`);
        // ~1s server-side cancel; a 30s sleep or a leaked connection would
        // blow these bounds.
        s.assert(elapsed >= 800 && elapsed < 8000, `probe ${i} took ${elapsed}ms (expect ~1000ms)`);
      }
      // The pool is still healthy: a fast probe succeeds right after the
      // cancellations, on a connection that came back.
      const res = await withDeadline(pool.query('SELECT 1'), 10_000, 'SELECT 1 after cancellations');
      s.assertEqual(res.rows.length, 1, 'SELECT 1 after the cancellations');
    } finally {
      await pool.end();
    }
  });

  /* -- c. concurrent probes queue through max=2 without losing work ------- */
  await s.check('concurrent probes queue through max=2 without losing work', async () => {
    const pool = createHealthPool(s.db.url, { error: () => {} });
    try {
      const started = Date.now();
      const results = await withDeadline(
        Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.3)'))),
        10_000,
        'concurrent probes',
      );
      const elapsed = Date.now() - started;
      // 6 × 0.3s on a max-2 pool = 3 batches ≈ 0.9s; the point is all six
      // succeed (queued, not dropped) — and each stays under the 1s
      // statement_timeout.
      s.assertEqual(results.length, 6, 'all six concurrent probes succeeded');
      s.assert(elapsed < 3000, `6 concurrent 0.3s probes took ${elapsed}ms (expect ~900ms)`);
    } finally {
      await pool.end();
    }
  });

  /* -- d. daemon-level single-flight under a blocked gauge query ----------- */
  await s.check('concurrent /metrics scrapes share one blocked gauge query (single-flight)', async () => {
    const daemon = spawnDaemon({ databaseUrl: s.db.url, port: await freePort() });
    try {
      await waitForHealth(daemon.url!);
    } catch (err) {
      await daemon.kill();
      throw err;
    }
    try {
      // Block the gauge query server-side: an ACCESS EXCLUSIVE lock on the
      // queue table makes every scrape's `SELECT ... FROM queue` wait — and
      // statement_timeout cancels the waiting statement at ~1s.
      const blocker = await s.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE queue IN ACCESS EXCLUSIVE MODE');
      try {
        const started = Date.now();
        const scrapes = await withDeadline(
          Promise.all(
            Array.from({ length: 10 }, async () => {
              const res = await fetch(`${daemon.url}/api/v1/metrics`);
              return { status: res.status, body: await res.text() };
            }),
          ),
          15_000,
          'concurrent scrapes',
        );
        const elapsed = Date.now() - started;
        for (const { status, body } of scrapes) {
          s.assertEqual(status, 200, 'scrape status');
          s.assert(body.includes('better_trigger_db_up 0'), 'db_up 0 while the gauge query is blocked');
        }
        // Single-flight: 10 concurrent scrapes shared ONE blocked query, all
        // answered when statement_timeout cancelled it (~1s). Without the
        // guard, scrapes beyond the pool's max=2 queue and hit their own 2s
        // HTTP deadlines in waves (~5s+ for 10 scrapes).
        s.assert(elapsed < 4000, `10 concurrent blocked scrapes took ${elapsed}ms (expect ~1s)`);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }

      // With the lock gone, the same scrape sees the gauges again — the probe
      // pool survived the storm.
      const after = await withDeadline(fetch(`${daemon.url}/api/v1/metrics`), 10_000, 'post-lock scrape');
      s.assert(
        (await after.text()).includes('better_trigger_db_up 1'),
        'db_up 1 after the lock is released',
      );

      // The health probe is a SELECT 1 (nothing to block), so its guard shows
      // as throughput: 10 concurrent deep probes all answer fast and healthy.
      const healthStarted = Date.now();
      const healths = await withDeadline(
        Promise.all(
          Array.from({ length: 10 }, async () => {
            const res = await fetch(`${daemon.url}/api/v1/health?deep=1`);
            return res.status;
          }),
        ),
        10_000,
        'concurrent deep health probes',
      );
      const healthElapsed = Date.now() - healthStarted;
      for (const status of healths) s.assertEqual(status, 200, 'deep health status');
      s.assert(healthElapsed < 4000, `10 concurrent deep health probes took ${healthElapsed}ms`);
    } finally {
      await daemon.stop();
    }
  });
}

void runScenario(
  {
    name: 'health-pool',
    what: 'probe pool: statement_timeout server-side, 57014 cancellation, connection return, single-flight',
    db: { name: 'better_trigger_health_pool', envVar: 'BT_HEALTH_POOL_DB' },
  },
  main,
);
