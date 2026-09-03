/* =============================================================================
   @better-trigger/kernel — 04-T2 against a real Postgres: the C4 takeover
   guard sees OLD-FORMAT worker manifests.

   workers.tasks carries `{ id, codeVersion }` pairs now, but rows written by
   an older build hold bare id strings; every OTHER reader normalizes both
   shapes (orchestrator.ts servedTaskIds, queue.ts scanStrandedRuns) — the
   guard itself used a jsonb_build_object containment that only matches the
   pair shape, so during a rolling upgrade from an old build the online OLD
   workers were invisible to it and a new registration could take over the
   latest_code_version / retry / cron of tasks they are still serving: the
   rollback C4 exists to prevent.

   The stub suite (test/registration-cron.test.ts) mirrors the rule and pins
   the SQL shape; only real Postgres proves the COALESCE normalization
   actually matches seeded old-format rows.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Kernel, KernelLogger } from '../../src/index';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK_ID = 'greet';

function recordingLogger(): { logger: KernelLogger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      warn: (...args: unknown[]) => warns.push(args.map(String).join(' ')),
      error: () => {},
    },
  };
}

async function register(kernel: Kernel, codeVersion: string, logger: KernelLogger) {
  return kernel.registerWorker({
    codeVersion,
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: TASK_ID, codeVersion }],
    logger,
  });
}

/** Rewrite a worker's manifest to the OLD shape: bare task-id strings, no
 *  per-task codeVersion (what an older build wrote). */
async function toLegacyFormat(pool: Pool, workerId: string): Promise<void> {
  await pool.query(`UPDATE workers SET tasks = $2::jsonb WHERE id = $1`, [
    workerId,
    JSON.stringify([TASK_ID]),
  ]);
}

async function storedVersion(pool: Pool): Promise<string | null> {
  const res = await pool.query<{ latest_code_version: string | null }>(
    `SELECT latest_code_version FROM tasks
      WHERE project_id = $1 AND env = $2 AND id = $3`,
    [NS.projectId, NS.env, TASK_ID],
  );
  return res.rows[0]?.latest_code_version ?? null;
}

describePg('C4 takeover guard — legacy manifest normalization (04-T2)', () => {
  it('an online OLD-FORMAT worker serving the stored version blocks a new-version takeover', async () => {
    await withPg('guard_legacy_blocks', async ({ kernel, pool }) => {
      const { logger, warns } = recordingLogger();
      const { workerId } = await register(kernel, 'v1', logger);
      expect(await storedVersion(pool)).toBe('v1');

      // The v1 worker is an OLD build: its row holds the bare-id shape.
      await toLegacyFormat(pool, workerId);

      // A v2 build registers the same task. Its own row (pair shape, serving
      // v2) must not mask the old worker, and the old worker must not be
      // invisible: the stored v1 is still served → the guard refuses.
      await register(kernel, 'v2', logger);

      expect(await storedVersion(pool)).toBe('v1');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(TASK_ID);
      expect(warns[0]).toContain('v2');
      expect(warns[0]).toContain('NOT applied');
      // The new worker row itself still landed — only the metadata takeover
      // was refused.
      const workers = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM workers WHERE status = 'online'`,
      );
      expect(workers.rows[0]!.n).toBe(2);
    });
  });

  it('an online PAIR-FORMAT worker serving the stored version still blocks (old behaviour kept)', async () => {
    await withPg('guard_pair_blocks', async ({ kernel, pool }) => {
      const { logger, warns } = recordingLogger();
      await register(kernel, 'v1', logger);
      expect(await storedVersion(pool)).toBe('v1');

      await register(kernel, 'v2', logger);

      expect(await storedVersion(pool)).toBe('v1');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('NOT applied');
    });
  });

  it('takeover is allowed once the old-format workers of the stored version are gone', async () => {
    await withPg('guard_legacy_takeover', async ({ kernel, pool }) => {
      const { logger, warns } = recordingLogger();
      const { workerId } = await register(kernel, 'v1', logger);
      await toLegacyFormat(pool, workerId);
      // The old worker goes offline (deregistered / marker sweep) — nothing
      // serves v1 anymore, so the upgrade path opens.
      await pool.query(`UPDATE workers SET status = 'offline' WHERE id = $1`, [workerId]);

      await register(kernel, 'v2', logger);

      expect(await storedVersion(pool)).toBe('v2');
      expect(warns).toEqual([]);
    });
  });

  it('an old-format row with a STALE heartbeat does not block (window shared with the other served checks)', async () => {
    await withPg('guard_legacy_stale', async ({ kernel, pool }) => {
      const { logger, warns } = recordingLogger();
      const { workerId } = await register(kernel, 'v1', logger);
      await toLegacyFormat(pool, workerId);
      // Still status='online', but silent past WORKER_OFFLINE_MS — the same
      // window the cron served-check and the stranded scan apply (04-T4).
      await pool.query(
        `UPDATE workers SET last_heartbeat_at = now() - interval '3 minutes' WHERE id = $1`,
        [workerId],
      );

      await register(kernel, 'v2', logger);

      expect(await storedVersion(pool)).toBe('v2');
      expect(warns).toEqual([]);
    });
  });

  it('an old-format worker of a DIFFERENT version does not block the stored one', async () => {
    await withPg('guard_legacy_other_version', async ({ kernel, pool }) => {
      const { logger, warns } = recordingLogger();
      const { workerId } = await register(kernel, 'v1', logger);
      // Legacy rows normalize their bare ids to the WORKER-level code_version:
      // a row from v0 serves (greet, v0), not the stored (greet, v1).
      await pool.query(`UPDATE workers SET tasks = $2::jsonb, code_version = 'v0' WHERE id = $1`, [
        workerId,
        JSON.stringify([TASK_ID]),
      ]);

      await register(kernel, 'v2', logger);

      expect(await storedVersion(pool)).toBe('v2');
      expect(warns).toEqual([]);
    });
  });
});
