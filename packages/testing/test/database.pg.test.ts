import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '@better-trigger/db';
import { describe, expect, it, vi } from 'vitest';
import { databaseUrlFor, resetDb } from '../src/database';

const describePg = process.env.DATABASE_URL ? describe : describe.skip;

function scenarioProcess(prefix: string, cwd: string) {
  const child = spawn('bun', [fileURLToPath(new URL('./fixtures/database-scenario.ts', import.meta.url)), prefix], {
    cwd,
    env: { ...process.env, BT_KEEP_TEST_DATABASE: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  // A failed/finished child may close its input before the finally releases it.
  child.stdin.on('error', () => {});
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => { output += error.message; resolve(-1); });
    child.once('close', resolve);
  });
  return {
    child,
    exited,
    output: () => output,
    name: () => /^READY ([a-z0-9_]+)$/m.exec(output)?.[1],
    release: () => { if (!child.stdin.destroyed) child.stdin.end('finish\n'); },
  };
}

describePg('database isolation on PostgreSQL', () => {
  it('connects to unique lowercase, length-bounded instances created concurrently', async () => {
    const instances: Awaited<ReturnType<typeof resetDb>>[] = [];
    try {
      const results = await Promise.allSettled([1, 2].map(async () => {
        const instance = await resetDb({ name: `BT_${'LONG_PREFIX_'.repeat(20)}` });
        instances.push(instance);
      }));
      // Wait for both owners even on failure so finally cannot miss a late CREATE.
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      expect(new Set(instances.map(({ name }) => name)).size).toBe(2);
      for (const instance of instances) {
        expect(instance.name).toMatch(/^bt_long_prefix_long_prefix_lon_[a-f0-9]{32}$/);
        expect(Buffer.byteLength(instance.name)).toBe(63);
        const result = await instance.pool.query(
          "SELECT current_database() AS name, current_setting('application_name') AS application",
        );
        expect(result.rows[0].name).toBe(instance.name);
        const application = new URL(process.env.DATABASE_URL!).searchParams.get('application_name');
        if (application !== null) expect(result.rows[0].application).toBe(application);
      }
    } finally {
      await Promise.all(instances.map((instance) => instance.drop()));
    }
  }, 30_000);

  it('runs the same scenario in two processes, preserves a pre-existing prefix DB, and leaves no instance behind', async () => {
    const prefix = `bt_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = createPool(databaseUrlFor('postgres'));
    let sentinelCreated = false;
    let sentinel: ReturnType<typeof createPool> | undefined;
    const processes: ReturnType<typeof scenarioProcess>[] = [];
    try {
      await admin.query(`CREATE DATABASE "${prefix}"`);
      sentinelCreated = true;
      sentinel = createPool(databaseUrlFor(prefix));
      await sentinel.query('CREATE TABLE sentinel (value text)');
      await sentinel.query("INSERT INTO sentinel VALUES ('untouched')");
      processes.push(
        scenarioProcess(prefix, fileURLToPath(new URL('..', import.meta.url))),
        scenarioProcess(prefix, fileURLToPath(new URL('../../..', import.meta.url))),
      );
      await vi.waitFor(() => {
        for (const process of processes) expect(process.name(), process.output()).toBeDefined();
      }, { timeout: 15_000, interval: 20 });
      const [first, second] = processes;
      const names = processes.map((process) => process.name()!);
      expect(new Set(names).size).toBe(2);
      expect(names).not.toContain(prefix);
      const liveNames = async () => (await admin.query(
        'SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname', [prefix],
      )).rows.map((row: { datname: string }) => row.datname);
      expect(await liveNames()).toEqual([prefix, ...names].sort());
      first!.release();
      expect(await first!.exited, first!.output()).toBe(0);
      // The other process still holds its transaction/connection here.
      expect(await liveNames()).toEqual([prefix, second!.name()!].sort());
      expect((await sentinel.query('SELECT value FROM sentinel')).rows).toEqual([{ value: 'untouched' }]);
      second!.release();
      expect(await second!.exited, second!.output()).toBe(0);
      expect(await liveNames()).toEqual([prefix]);
      for (const process of processes) {
        expect(process.output()).toContain('isolated transaction and connection survived peer cleanup');
        expect(process.output()).not.toContain('database retained');
      }
    } finally {
      for (const process of processes) process.release();
      await Promise.all(processes.map((process) => process.exited));
      await sentinel?.end();
      if (sentinelCreated) await admin.query(`DROP DATABASE "${prefix}" WITH (FORCE)`);
      await admin.end();
    }
  }, 40_000);
});
