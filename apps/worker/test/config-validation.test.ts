/* =============================================================================
   @better-trigger/worker — config input validation (todos/p1-16):
   integer CLI values and the lease-ms floor.

   requireInt demands a positive INTEGER (p1-16 C3): `--concurrency 2.5` used
   to be silently truncated to 2 slots by `Array.from({ length })` and
   `--port 4848.5` only blew up later inside listen() — while the env twins
   (BETTER_TRIGGER_CONCURRENCY via parsePositiveIntEnv) already refused both.

   --lease-ms refuses anything below MIN_LEASE_MS (p1-16 C2): the heartbeat
   renews at most every 500ms, so a shorter lease expires before its first
   renewal and the reaper recovers live runs until they fail WorkerLostError.
   Both entries (CLI + embedded) share the floor.

   parseArgs is exercised directly for exact messages, plus one spawned CLI
   run to prove the refusal lands at startup — an unreachable DATABASE_URL
   means a case that got past parsing would stall instead of exiting (same
   trick as concurrency-env.test.ts).
   ============================================================================= */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { task } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { MIN_LEASE_MS, parseArgs } from '../src/cli';
import { createEmbeddedRuntime } from '../src/embedded';

const ENTRY = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with these argv and collect how it exited. */
function cli(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    const child = spawn('bun', [ENTRY, ...args], {
      env: {
        ...clean,
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
  });
}

describe('requireInt integer strictness (p1-16 C3)', () => {
  it('rejects fractional values that used to pass the finite check', () => {
    expect(() => parseArgs(['--concurrency', '2.5'])).toThrow(
      '--concurrency must be a positive integer, got "2.5"',
    );
    expect(() => parseArgs(['--port', '4848.5'])).toThrow(
      '--port must be a positive integer, got "4848.5"',
    );
    expect(() => parseArgs(['--timer-interval-ms', '1000.5'])).toThrow(
      /positive integer/,
    );
  });

  it('still accepts positive integers', () => {
    expect(parseArgs(['--concurrency', '2', '--port', '4848']).concurrency).toBe(2);
  });
});

describe('lease-ms floor (p1-16 C2)', () => {
  it('parseArgs refuses a lease shorter than 3x the 500ms heartbeat floor', () => {
    expect(() => parseArgs(['--lease-ms', '100'])).toThrow(/--lease-ms must be at least 1500/);
    expect(() => parseArgs(['--lease-ms', String(MIN_LEASE_MS - 1)])).toThrow(/at least 1500/);
    // Fractional / non-numeric still fail the integer check first.
    expect(() => parseArgs(['--lease-ms', '60000.5'])).toThrow(/positive integer/);
  });

  it('parseArgs accepts the floor and above', () => {
    expect(parseArgs(['--lease-ms', String(MIN_LEASE_MS)]).leaseMs).toBe(MIN_LEASE_MS);
    expect(parseArgs(['--lease-ms', '60000']).leaseMs).toBe(60_000);
  });

  it('createEmbeddedRuntime refuses the same range before touching any pool', async () => {
    await expect(
      createEmbeddedRuntime({
        tasks: [task('t', async () => undefined)],
        pool: {} as unknown as Pool,
        leaseMs: 100,
        migrate: false,
      }),
    ).rejects.toThrow(/leaseMs must be an integer of at least 1500/);
    // Non-integer is refused on the same boundary.
    await expect(
      createEmbeddedRuntime({
        tasks: [task('t2', async () => undefined)],
        pool: {} as unknown as Pool,
        leaseMs: 2000.5,
        migrate: false,
      }),
    ).rejects.toThrow(/leaseMs must be an integer of at least 1500/);
  });

  it('the real CLI refuses to start on --lease-ms 100, during parsing', async () => {
    const run = await cli(['--lease-ms', '100', '--no-migrate']);
    expect(run.code).not.toBe(0);
    expect(`${run.stderr}${run.stdout}`).toMatch(/--lease-ms must be at least 1500/);
  });
});