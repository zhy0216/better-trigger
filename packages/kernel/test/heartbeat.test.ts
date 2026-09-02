/* =============================================================================
   @better-trigger/kernel — heartbeat lostRunIds (C2).

   The renewal statement is already scoped by `locked_by = us`, so the rows it
   touches ARE the claims this worker still holds. What this pins is that the
   answer is derived from those rows and nothing else:

     - the loss set is "asked for minus renewed", per run id — a partial hit
       must report exactly the misses, not "all" or "none";
     - a canceled run never shows up as lost as well: the cancel is the more
       specific instruction for the same run, and the worker's reaction to the
       two differs (abort reason 'canceled' vs 'lease_lost');
     - it stays at two round trips. Nothing may issue an extra query to work
       out something the renewal already returned;
     - a heartbeat whose worker row is gone (pruned after an offline+stale
       window) is an error — the not_found that tells the caller to
       re-register — never a silent 0-row success.

   No Postgres: a stub pool answers the three statements and records them.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { heartbeat } from '../src/queue';

interface Stmt {
  sql: string;
  params: unknown[];
}

/**
 * A pool whose renewal statement claims to have touched `renewedRunIds` (i.e.
 * those are the rows still `locked_by` us) and whose runs table reports
 * `canceledRunIds` as canceled. `workerRowPresent: false` makes the workers
 * liveness UPDATE touch 0 rows — the pruned-row case.
 */
function stubPool(opts: { renewed: string[]; canceled?: string[]; workerRowPresent?: boolean }) {
  const stmts: Stmt[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/UPDATE queue/.test(sql)) {
        return { rows: opts.renewed.map((run_id) => ({ run_id })) };
      }
      if (/UPDATE workers/.test(sql)) {
        return { rows: [], rowCount: opts.workerRowPresent === false ? 0 : 1 };
      }
      if (/FROM runs/.test(sql)) {
        return { rows: (opts.canceled ?? []).map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, stmts };
}

const ARGS = { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE], leaseMs: 60_000 };

describe('heartbeat lease loss', () => {
  it('reports nothing lost when every lease renews', async () => {
    const { pool } = stubPool({ renewed: ['run_1', 'run_2'] });

    const res = await heartbeat(pool, { ...ARGS, runIds: ['run_1', 'run_2'] });

    expect(res.lostRunIds).toEqual([]);
    expect(res.cancelRunIds).toEqual([]);
  });

  it('reports exactly the runs the renewal missed', async () => {
    // The reaper took run_2 and handed it to another daemon; run_1 and run_3
    // are still ours.
    const { pool } = stubPool({ renewed: ['run_1', 'run_3'] });

    const res = await heartbeat(pool, { ...ARGS, runIds: ['run_1', 'run_2', 'run_3'] });

    expect(res.lostRunIds).toEqual(['run_2']);
  });

  it('reports all of them when the worker holds nothing anymore', async () => {
    // What a reaped-out daemon (paused VM, long GC, network partition) sees on
    // its first heartbeat back.
    const { pool } = stubPool({ renewed: [] });

    const res = await heartbeat(pool, { ...ARGS, runIds: ['run_1', 'run_2'] });

    expect(res.lostRunIds).toEqual(['run_1', 'run_2']);
  });

  it('calls a canceled run canceled, not lost', async () => {
    // Cancel deletes the queue row, so the renewal misses it too — but the
    // worker must abort it with reason 'canceled'. The two sets stay disjoint.
    const { pool } = stubPool({ renewed: ['run_1'], canceled: ['run_2'] });

    const res = await heartbeat(pool, { ...ARGS, runIds: ['run_1', 'run_2'] });

    expect(res.cancelRunIds).toEqual(['run_2']);
    expect(res.lostRunIds).toEqual([]);
  });

  it('derives the loss set from the renewal itself, in two round trips', async () => {
    const { pool, stmts } = stubPool({ renewed: ['run_1'] });

    await heartbeat(pool, { ...ARGS, runIds: ['run_1', 'run_2'] });

    // The renewal answers "which are still mine" because it is scoped by us
    // and returns its rows; no extra ownership query rides along.
    const renew = stmts.find((s) => /UPDATE queue/.test(s.sql))!;
    expect(renew.sql).toMatch(/WHERE locked_by = \$2 AND run_id = ANY\(\$3::text\[\]\)/);
    expect(renew.sql).toMatch(/RETURNING run_id/);
    expect(stmts.filter((s) => /queue/.test(s.sql))).toHaveLength(1);
    // Unchanged shape otherwise: renew + worker touch + cancel lookup.
    expect(stmts).toHaveLength(3);
  });

  it('skips both lookups when nothing is in flight', async () => {
    const { pool, stmts } = stubPool({ renewed: [] });

    const res = await heartbeat(pool, { ...ARGS, runIds: [] });

    expect(res).toEqual({ cancelRunIds: [], lostRunIds: [] });
    // Only the worker's own liveness row is written.
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/UPDATE workers/);
  });

  it('still renews the leases it does hold', async () => {
    const { pool, stmts } = stubPool({ renewed: ['run_1'] });

    await heartbeat(pool, { ...ARGS, runIds: ['run_1', 'run_2'] });

    const renew = stmts.find((s) => /UPDATE queue/.test(s.sql))!;
    expect(renew.sql).toMatch(/SET lease_until = now\(\)/);
    expect(renew.params).toEqual(['60000', 'w1', ['run_1', 'run_2'], 'default', 'prod']);
    // locked_at keeps its claim-time meaning.
    expect(renew.sql).not.toMatch(/locked_at/);
  });
});

describe('heartbeat with the workers row pruned away', () => {
  it('refuses with not_found when the liveness UPDATE touches 0 rows', async () => {
    // prune deletes an offline-and-stale row while the process stays alive
    // (long partition + retention). The heartbeat used to ride that out as a
    // silent 0-row UPDATE — the worker kept claiming while invisible to
    // servedTaskIds / the stranded scan / the offline marker / the dashboard.
    // The 0-row touch is now the re-register signal.
    const { pool, stmts } = stubPool({ renewed: [], workerRowPresent: false });

    await expect(heartbeat(pool, { ...ARGS, runIds: ['run_1'] })).rejects.toBeInstanceOf(
      KernelError,
    );
    await heartbeat(pool, { ...ARGS, runIds: ['run_1'] }).catch((err: KernelError) => {
      expect(err.code).toBe('not_found');
      expect(err.message).toMatch(/w1 no longer has a workers row/);
      expect(err.message).toMatch(/re-register/);
    });
    // The cancel-check read never runs — the error is raised on the liveness
    // touch that sits where the old silent UPDATE was.
    expect(stmts.some((s) => /SELECT id FROM runs/.test(s.sql))).toBe(false);
  });

  it('also fires with nothing in flight — the row check is unconditional', async () => {
    const { pool, stmts } = stubPool({ renewed: [], workerRowPresent: false });

    await expect(heartbeat(pool, { ...ARGS, runIds: [] })).rejects.toBeInstanceOf(KernelError);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/UPDATE workers/);
  });

  it('a live row keeps the historical success shape', async () => {
    const { pool } = stubPool({ renewed: ['run_1'], workerRowPresent: true });

    await expect(heartbeat(pool, { ...ARGS, runIds: ['run_1'] })).resolves.toEqual({
      cancelRunIds: [],
      lostRunIds: [],
    });
  });
});
