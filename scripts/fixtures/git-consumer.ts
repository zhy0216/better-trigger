import { strict as assert } from 'node:assert';
import pg from 'pg';
import { task, unwrapResult } from '@better-trigger/source/sdk';
import { createEmbeddedRuntime } from '@better-trigger/source/worker/embedded';

let stepCalls = 0;
const child = task('git-child', async (payload: { value: number }, ctx) =>
  ctx.step('double', () => payload.value * 2),
);
const workflow = task('git-workflow', async (payload: { value: number }, ctx) => {
  const initial = await ctx.step('prepare', () => { stepCalls++; return payload.value; });
  await ctx.wait.for('10ms');
  return unwrapResult(await child.triggerAndWait({ value: initial }));
});

assert.equal(typeof createEmbeddedRuntime, 'function');
await assert.rejects(createEmbeddedRuntime({ tasks: [workflow] }), /databaseUrl or pool/);
console.log('source imports and explicit configuration: OK');

// This is the one opt-in for database work. The caller's database is used only
// to CREATE/DROP our randomly named test database; all test SQL stays inside it.
const adminUrl = process.env.BT_GIT_TEST_ADMIN_URL;
if (adminUrl) {
  process.env.BETTER_TRIGGER_MAX_PAYLOAD_BYTES = '1';
  process.env.BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES = '1';
  process.env.BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES = '1';
  process.env.BETTER_TRIGGER_MAX_RECOVERIES = '999';
  const admin = new pg.Pool({ connectionString: adminUrl });
  const database = `bt_git_${crypto.randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool | undefined;
  let runtime: Awaited<ReturnType<typeof createEmbeddedRuntime>> | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.href });
    await pool.query('CREATE TABLE application_items (id integer PRIMARY KEY, title text NOT NULL)');
    await pool.query("INSERT INTO application_items VALUES (1, 'keep me')");
    const namespace = { projectId: 'git-consumer', env: 'test' };
    runtime = await createEmbeddedRuntime({
      pool,
      databaseUrl: url.href,
      tasks: [workflow, child],
      concurrency: 2,
      namespaces: [namespace],
      orchestrator: { timerIntervalMs: 20 },
    });
    const first = await workflow.trigger({ value: 21 }, { ...namespace, idempotencyKey: 'smoke' });
    const duplicate = await workflow.trigger({ value: 21 }, { ...namespace, idempotencyKey: 'smoke' });
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.idempotent, true);
    const result = await first.result({ timeoutMs: 10_000, throwOnTimeout: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 42);
    assert.equal((await pool.query('SELECT max_recoveries FROM runs WHERE id = $1', [first.id])).rows[0]?.max_recoveries, 10);
    assert.equal(stepCalls, 1, 'durable replay must not repeat a completed step');
    assert.equal((await pool.query('SELECT title FROM application_items WHERE id = 1')).rows[0]?.title, 'keep me');
    await Promise.all([runtime.stop(), runtime.stop()]);
    assert.equal((await pool.query('SELECT status FROM workers WHERE id = $1', [runtime.worker.workerId])).rows[0]?.status, 'offline');
    assert.equal((await runtime.fetch('http://better-trigger.internal/api/v1/health')).status, 503);
    // Injected pool remains usable and a second boot reapplies migrations safely.
    runtime = await createEmbeddedRuntime({ pool, tasks: [workflow, child], namespaces: [namespace] });
    await runtime.stop();
    runtime = undefined;
    console.log('Postgres migrations, application table coexistence, namespaced trigger, child workflow, replay, idempotency and shutdown: OK');
  } finally {
    await runtime?.stop();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  }
}
