/* Real storage/replay regression: use the executor as a test-only consumer of
 * the kernel, so both fingerprint producers cross the actual jsonb boundary.
 * Historical fingerprints below were captured before canonicalization changed;
 * the completed ledger is only compared, never migrated to make replay pass. */
import { beforeAll, expect, it } from 'vitest';
import { NonDeterminismError, type ClaimedRun, type RetryPolicy, type TriggerItem } from '@better-trigger/core';
import { stepFingerprint } from '../../src/fingerprint';
import { describePg, withPg, type PgContext } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
// A runtime-loaded consumer keeps the kernel's declaration build independent
// of worker source. Static cross-package source imports make tsdown emit worker
// declarations outside kernel/dist. This driver only needs these public calls.
type Task = {
  id: string;
  retry?: RetryPolicy;
  run: (payload: unknown, context: {
    triggerAndWait: (taskId: string, payload: unknown) => Promise<unknown>;
    step: (label: string, fn: () => unknown) => Promise<unknown>;
  }) => unknown;
};
type ExecutorDriver = {
  execute(): Promise<unknown>;
  durableBatchTrigger(items: TriggerItem[], label: string): Promise<string[]>;
};
let Executor: new (kernel: PgContext['kernel'], task: Task, run: ClaimedRun, workerId: string, diagnostics: null) => ExecutorDriver;

async function setup(ctx: PgContext, payload: unknown = {}) {
  const { workerId } = await ctx.kernel.registerWorker({
    codeVersion: 'deploy-new', runtime: 'test', concurrency: 2,
    namespaces: [NS],
    tasks: [{ id: 'parent', codeVersion: 'v1' }, { id: 'child', codeVersion: 'v1' }],
  });
  await ctx.kernel.trigger({ taskId: 'parent', payload, namespace: NS });
  return { workerId, run: await claim(ctx, workerId, 'parent') };
}

async function claim(ctx: PgContext, workerId: string, taskId: string) {
  const runs = await ctx.kernel.claimRuns({
    workerId, namespaces: [NS], taskIds: [taskId], limit: 1, leaseMs: 60_000,
  });
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

function owned(run: ClaimedRun, workerId: string) {
  return { runId: run.id, workerId, fencingToken: run.fencingToken, namespace: NS };
}

async function ledger(ctx: PgContext, runId: string) {
  // Include every stored column, not just fingerprint/output. A no-op replay
  // must also preserve the original timestamps, attempt and labels.
  const result = await ctx.pool.query<{ row: string }>(
    'SELECT row_to_json(s)::text AS row FROM run_steps s WHERE run_id = $1 ORDER BY seq',
    [runId],
  );
  return result.rows;
}

async function children(ctx: PgContext, runId: string) {
  const result = await ctx.pool.query<{ id: string; payload: unknown }>(
    'SELECT id, payload FROM runs WHERE parent_run_id = $1 ORDER BY id', [runId],
  );
  return result.rows;
}

const specialPayload = () => JSON.parse(
  '{"zz":0,"__proto__":{"secret":true},"a":[{"constructor":1,"__proto__":null,"prototype":2}]}',
);

function selfReturning(payload: unknown, calls: string[]) {
  // Methods are constructed inside tasks; the initial trigger itself already
  // crossed JSON. Each serialization calls this hook once, with its own key.
  return Object.defineProperty(payload, 'toJSON', {
    value: function (this: unknown, key: string) {
      calls.push(key);
      if (calls.length > 4) throw new Error('toJSON re-entered');
      return this;
    },
  });
}

describePg('canonical fingerprints across storage and replay', () => {
  beforeAll(async () => {
    const consumer = new URL('../../../../apps/worker/src/executor.ts', import.meta.url);
    ({ Executor } = await import(consumer.href));
  });

  it('replays a pre-fix ordinary ledger after jsonb and claim handover without rewriting it', async () => {
    await withPg('canonical_old_ledger', async (ctx) => {
      const payload = { z: [3, { y: 2, a: 1 }], a: true };
      const { kernel } = ctx;
      const { workerId, run } = await setup(ctx, payload);
      expect(run.payload).toEqual(payload);
      // ctx.triggerAndWait has always supplied options:{}; the direct
      // executor API's options:undefined is a distinct pre-existing signature.
      const oldFingerprint = 'd4934a8d1f4e3e61';
      const output = { id: 'historical_child', ok: true, output: payload };
      const report = {
        ...owned(run, workerId), seq: 0, kind: 'trigger-and-wait' as const,
        status: 'completed' as const, output, fingerprint: oldFingerprint,
        attempt: 1, startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z',
      };
      await kernel.reportStep(report);
      const before = await ledger(ctx, run.id);
      const fingerprint = stepFingerprint({
        kind: 'trigger-and-wait', label: null, codeVersion: run.codeVersion,
        input: { taskId: 'child', payload: run.payload, options: {} },
      });
      expect(fingerprint).toBe(oldFingerprint);
      await kernel.reportStep({ ...report, fingerprint, output: 'must not overwrite', attempt: 2 });
      const changed = stepFingerprint({
        kind: 'trigger-and-wait', label: null, codeVersion: run.codeVersion,
        input: { taskId: 'child', payload: { ...payload, a: false }, options: {} },
      });
      await expect(kernel.reportStep({ ...report, fingerprint: changed })).rejects.toBeInstanceOf(NonDeterminismError);
      expect(await ledger(ctx, run.id)).toEqual(before);

      await kernel.releaseClaims({ workerId, namespaces: [NS] });
      const replay = await claim(ctx, workerId, 'parent');
      expect(replay.fencingToken).toBeGreaterThan(run.fencingToken);
      expect(replay.codeVersion).toBe('v1');
      expect(replay.steps[0]?.fingerprint).toBe(oldFingerprint);
      const task: Task = { id: 'parent', run: (value, context) => context.triggerAndWait('child', value) };
      expect(await new Executor(kernel, task, replay, workerId, null).execute()).toEqual({ type: 'completed', output });
      expect(await children(ctx, run.id)).toEqual([]);
      expect(await ledger(ctx, run.id)).toEqual(before);
    });
  });

  it.each(['completed', 'failed'] as const)('preserves special keys and a self-returning hook through a %s child and parent replay', async (outcome) => {
    await withPg(`canonical_child_${outcome}`, async (ctx) => {
      const { kernel } = ctx;
      const payload = specialPayload();
      const { workerId, run } = await setup(ctx, payload);
      const calls: string[] = [];
      const task: Task = {
        id: 'parent',
        run: (value, context) => context.triggerAndWait('child', selfReturning(value, calls)),
      };
      expect(await new Executor(kernel, task, run, workerId, null).execute()).toEqual({ type: 'suspended' });
      expect(calls).toEqual(['payload', '']); // fingerprint, then payload storage
      const child = await claim(ctx, workerId, 'child');
      expect(child.payload).toEqual(payload);
      expect(Object.hasOwn(child.payload as object, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(child.payload)).toBe(Object.prototype);
      const { rows: waits } = await ctx.pool.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM waits WHERE run_id = $1', [run.id],
      );
      expect(waits).toHaveLength(1);
      const fingerprint = stepFingerprint({
        kind: 'trigger-and-wait', label: null, codeVersion: 'v1',
        input: { taskId: 'child', payload: child.payload, options: {} },
      });
      expect(waits[0]!.fingerprint).toBe(fingerprint);
      const childTask: Task = {
        id: 'child', retry: { maxAttempts: 1 },
        run: (value, context) => context.step('echo', () => {
          if (outcome === 'failed') throw new TypeError('child service failed');
          return value;
        }),
      };
      expect(await new Executor(kernel, childTask, child, workerId, null).execute()).toMatchObject({ type: outcome });
      const saved = await ledger(ctx, run.id);
      const replay = await claim(ctx, workerId, 'parent');
      expect(replay.steps[0]?.fingerprint).toBe(fingerprint);
      const result = await new Executor(kernel, task, replay, workerId, null).execute();
      const expected = outcome === 'completed'
        ? { id: child.id, ok: true, output: payload }
        : { id: child.id, ok: false, error: { name: 'TypeError', message: 'child service failed' } };
      expect(result).toMatchObject({ type: 'completed', output: expected });
      expect((await kernel.getRun(run.id, NS)).output).toMatchObject(expected);
      expect(calls).toEqual(['payload', '', 'payload']);
      expect(await children(ctx, run.id)).toEqual([{ id: child.id, payload }]);
      expect(await ledger(ctx, run.id)).toEqual(saved);
    });
  });

  it('matches the batch writer fingerprint to persisted special-key payloads and replays without another fan-out', async () => {
    await withPg('canonical_batch', async (ctx) => {
      const { kernel } = ctx;
      const { workerId, run } = await setup(ctx);
      const calls: string[] = [];
      const payload = specialPayload();
      const items = [{ taskId: 'child', payload: selfReturning(payload, calls) }];
      const task: Task = { id: 'parent', run: async () => undefined };
      const ids = await new Executor(kernel, task, run, workerId, null).durableBatchTrigger(items, 'fan-out');
      expect(calls).toEqual(['payload', '', 'payload']); // executor, storage, ledger writer
      const persisted = await children(ctx, run.id);
      expect(persisted).toEqual([{ id: ids[0], payload }]);
      expect(Object.hasOwn(persisted[0]!.payload as object, '__proto__')).toBe(true);
      const replayItems = [{ taskId: 'child', payload: persisted[0]!.payload }];
      const saved = await ledger(ctx, run.id);
      await kernel.releaseClaims({ workerId, namespaces: [NS] });
      const replay = await claim(ctx, workerId, 'parent');
      expect(replay.steps[0]?.fingerprint).toBe(stepFingerprint({
        kind: 'batch-trigger', label: 'fan-out', input: { items: replayItems }, codeVersion: replay.codeVersion,
      }));
      const executor = new Executor(kernel, task, replay, workerId, null);
      expect(await executor.durableBatchTrigger(replayItems, 'fan-out')).toEqual(ids);
      expect(await children(ctx, run.id)).toEqual(persisted);
      expect(await ledger(ctx, run.id)).toEqual(saved);
    });
  });

  it('refuses the old special-key collision and preserves its historical ledger', async () => {
    await withPg('canonical_old_special', async (ctx) => {
      const { kernel } = ctx;
      const { workerId, run } = await setup(ctx);
      const payload = JSON.parse('{"__proto__":{"secret":true},"a":2}');
      // The old serializer dropped __proto__, producing the same hash as {a:2}.
      const oldFingerprint = 'b05c5f4d91b30ec8';
      expect(stepFingerprint({
        kind: 'trigger-and-wait', label: null, codeVersion: 'v1',
        input: { taskId: 'child', payload: { a: 2 }, options: {} },
      })).toBe(oldFingerprint);
      const report = {
        ...owned(run, workerId), seq: 0, kind: 'trigger-and-wait' as const,
        status: 'completed' as const, output: { id: 'historical_child', ok: true, output: 'old' },
        fingerprint: oldFingerprint, attempt: 1,
        startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z',
      };
      await kernel.reportStep(report);
      const before = await ledger(ctx, run.id);
      const fingerprint = stepFingerprint({
        kind: 'trigger-and-wait', label: null, input: { taskId: 'child', payload, options: {} }, codeVersion: 'v1',
      });
      expect(fingerprint).not.toBe(oldFingerprint);
      await expect(kernel.reportStep({ ...report, fingerprint })).rejects.toBeInstanceOf(NonDeterminismError);
      await kernel.releaseClaims({ workerId, namespaces: [NS] });
      const replay = await claim(ctx, workerId, 'parent');
      const task: Task = { id: 'parent', run: (_value, context) => context.triggerAndWait('child', payload) };
      expect(await new Executor(kernel, task, replay, workerId, null).execute()).toEqual({ type: 'failed' });
      const failed = await kernel.getRun(run.id, NS);
      expect(failed).toMatchObject({
        status: 'failed', attempt: 1,
        error: { name: 'AbortError', message: expect.stringContaining('replay fingerprint mismatch') },
      });
      expect(await children(ctx, run.id)).toEqual([]);
      expect(await ledger(ctx, run.id)).toEqual(before);
    });
  });

  const invalid: Array<[string, () => unknown]> = [
    ['BigInt', () => ({ n: 1n })],
    ['circular', () => { const value: unknown[] = []; value.push(value); return value; }],
    ['unreadable hook failure', () => ({ toJSON() { throw Object.assign(Object.create(null), { n: 1n }); } })],
  ];
  for (const primitive of ['triggerAndWait', 'batchTrigger'] as const) {
    it.each(invalid)(`${primitive} rejects %s and persists a terminal diagnostic without children`, async (_name, makePayload) => {
      await withPg('canonical_invalid', async (ctx) => {
        const { kernel } = ctx;
        const { workerId, run } = await setup(ctx);
        const payload = makePayload();
        // The direct kernel boundary keeps its stable serialization_error.
        const direct = primitive === 'triggerAndWait'
          ? kernel.waitForChildRun({ ...owned(run, workerId), seq: 0, taskId: 'child', payload })
          : kernel.batchTriggerChild({ ...owned(run, workerId), seq: 0, items: [{ taskId: 'child', payload }] });
        await expect(direct).rejects.toMatchObject({ code: 'serialization_error' });
        expect((await kernel.getRun(run.id, NS)).status).toBe('running');
        const task: Task = {
          id: 'parent', retry: { maxAttempts: 3 },
          run: (_value, context) => primitive === 'triggerAndWait'
            ? context.triggerAndWait('child', payload)
            : executor.durableBatchTrigger([{ taskId: 'child', payload }], 'fan-out'),
        };
        const executor = new Executor(kernel, task, run, workerId, null);
        expect(await executor.execute()).toEqual({ type: 'failed' });
        expect(await kernel.getRun(run.id, NS)).toMatchObject({
          status: 'failed', attempt: 1,
          error: { name: 'AbortError', message: expect.stringContaining('not JSON-serializable') },
        });
        expect(await children(ctx, run.id)).toEqual([]);
        expect(await ledger(ctx, run.id)).toEqual([]);
        const pending = await ctx.pool.query('SELECT id FROM waits WHERE run_id = $1', [run.id]);
        expect(pending.rows).toEqual([]);
        const queued = await ctx.pool.query('SELECT run_id FROM queue WHERE run_id = $1', [run.id]);
        expect(queued.rows).toEqual([]);
      });
    });
  }
});
