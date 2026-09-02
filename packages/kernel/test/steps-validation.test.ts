/* =============================================================================
   @better-trigger/kernel — worker-message enum/format validation at the
   step/suspend boundaries (P2 hardening).

   reportStep / suspendRun receive worker messages that crossed JSON: values
   typed away at the call site are still arbitrary at runtime, and until now
   they reached PostgreSQL unchecked —

     - upsertStep with an out-of-set kind/status violated run_steps_kind_check
       / run_steps_status_check (23514);
     - suspendRun with an unparseable resumeAt bound an Invalid Date into
       waits.resume_at (a bare driver/22007 error);

   both landing as 500-class failures outside the KernelError family. The
   guards below refuse them at the kernel boundary with bad_request, BEFORE
   any transaction opens — the HTTP host's error mapping then answers 400 the
   same way it does for every other input mistake.

   No Postgres: a sentinel pool proves "never connected"; a recording client
   proves "no INSERT issued" for upsertStep.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { suspendRun, upsertStep, type StepWriteArgs } from '../src/runs';

/** Any use of this pool fails the test loudly — validation must throw first. */
const sentinel = new Error('connect() reached — validation did not refuse');
const refusingPool = {
  connect: async () => {
    throw sentinel;
  },
} as unknown as Pool;

const expectBadRequest = async (promise: Promise<unknown>, message: RegExp) => {
  await expect(promise).rejects.toBeInstanceOf(KernelError);
  await promise.catch((err: KernelError) => {
    expect(err.code).toBe('bad_request');
    expect(err.message).toMatch(message);
  });
};

/* ---------------------------------------------------------------------------
 * suspendRun — resumeAt format
 * ------------------------------------------------------------------------- */

describe('suspendRun resumeAt validation', () => {
  const suspend = (resumeAt: unknown) =>
    suspendRun(refusingPool, {
      runId: 'run_1',
      namespace: DEFAULT_NAMESPACE,
      seq: 1,
      kind: 'duration',
      resumeAt: resumeAt as string,
      workerId: 'w1',
      fencingToken: 1,
    });

  it('refuses garbage timestamps before opening the tx', async () => {
    for (const resumeAt of ['soon', 'next tuesday-ish', '', '2026-13-45T99:99:99Z', undefined, {}]) {
      await expectBadRequest(suspend(resumeAt), /resumeAt is not a valid timestamp/);
    }
  });

  it('lets a valid instant through to the fenced write (sentinel proves that)', async () => {
    await expect(suspend(new Date(Date.now() + 60_000).toISOString())).rejects.toBe(sentinel);
  });
});

/* ---------------------------------------------------------------------------
 * upsertStep — kind / status enums
 * ------------------------------------------------------------------------- */

describe('upsertStep kind/status validation', () => {
  /** Records statements; the tasks/runs reads are irrelevant here — the guard
   *  must fire before the step INSERT is ever sent. */
  const makeClient = () => {
    const sqls: string[] = [];
    const client = {
      query: async (sql: string) => {
        sqls.push(sql);
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    return { client, sqls };
  };

  const step = (over: Partial<StepWriteArgs> = {}): StepWriteArgs => ({
    runId: 'run_1',
    namespace: DEFAULT_NAMESPACE,
    seq: 1,
    kind: 'step',
    status: 'completed',
    attempt: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...over,
  });

  it('refuses an out-of-set kind before any statement', async () => {
    for (const kind of ['nope', '', 'STEP', 'sleep', null, 7]) {
      const { client, sqls } = makeClient();
      await expectBadRequest(
        upsertStep(client, step({ kind: kind as StepWriteArgs['kind'] })),
        /kind must be one of step, wait, trigger-and-wait, batch-trigger, now, random, uuid/,
      );
      expect(sqls).toEqual([]);
    }
  });

  it('refuses an out-of-set status before any statement', async () => {
    for (const status of ['pending', 'running', 'COMPLETED', '', null]) {
      const { client, sqls } = makeClient();
      await expectBadRequest(
        upsertStep(client, step({ status: status as StepWriteArgs['status'] })),
        /status must be one of completed, failed/,
      );
      expect(sqls).toEqual([]);
    }
  });

  it('accepts every in-set kind and status (write reached the client)', async () => {
    for (const kind of ['step', 'wait', 'trigger-and-wait', 'batch-trigger', 'now', 'random', 'uuid'] as const) {
      for (const status of ['completed', 'failed'] as const) {
        const { client, sqls } = makeClient();
        await expect(upsertStep(client, step({ kind, status }))).resolves.toEqual({ ok: true });
        expect(sqls.some((sql) => /INSERT INTO run_steps/.test(sql))).toBe(true);
      }
    }
  });
});
