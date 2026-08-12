/* =============================================================================
   @better-trigger/kernel — enqueue()'s two conflict semantics (p2-30).

   "Put a run back in the queue" is one concept and one SQL shape — the wait
   resume path used to hand-roll its own INSERT with DIFFERENT conflict
   semantics. Now both go through enqueue(), which carries the choice as an
   explicit flag: the default overwrites a surviving row's priority /
   concurrency_key (a fresh trigger's values are the truth), while
   `preserveSurvivor` only reschedules the survivor and keeps ITS values (the
   wait-resume case — a queue row that survived the suspend knows better).
   ============================================================================= */
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { enqueue } from '../src/queue';

const stmt = (preserveSurvivor: boolean): string => {
  let sql = '';
  const client = {
    query: async (s: string) => {
      sql = s;
      return { rowCount: 1 };
    },
  } as unknown as PoolClient;
  void enqueue(client, {
    runId: 'run_1',
    availableAt: new Date('2026-01-01T00:00:00Z'),
    priority: 10,
    concurrencyKey: 'k',
    namespace: DEFAULT_NAMESPACE,
    preserveSurvivor,
  });
  return sql;
};

describe('enqueue conflict semantics (p2-30)', () => {
  it('default overwrites a survivor’s priority and concurrency_key', () => {
    const sql = stmt(false);
    expect(sql).toMatch(/ON CONFLICT \(run_id\) DO UPDATE/);
    expect(sql).toMatch(/priority\s*=\s*EXCLUDED\.priority/);
    expect(sql).toMatch(/concurrency_key\s*=\s*EXCLUDED\.concurrency_key/);
    expect(sql).toMatch(/locked_by\s*=\s*NULL/);
  });

  it('preserveSurvivor keeps the survivor’s priority and concurrency_key', () => {
    const sql = stmt(true);
    expect(sql).toMatch(/ON CONFLICT \(run_id\) DO UPDATE/);
    expect(sql).not.toMatch(/priority\s*=\s*EXCLUDED/);
    expect(sql).not.toMatch(/concurrency_key\s*=\s*EXCLUDED/);
    // It still reschedules and clears a stale claim.
    expect(sql).toMatch(/available_at\s*=\s*EXCLUDED\.available_at/);
    expect(sql).toMatch(/locked_by\s*=\s*NULL/);
  });
});
