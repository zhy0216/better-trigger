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
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONCURRENCY,
  MAX_PORT,
  MIN_LEASE_MS,
  parseArgs,
  parsePruneArgs,
  urlHasCredentials,
} from '../src/cli';
import { createEmbeddedRuntime } from '../src/embedded';

const ENTRY = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with these argv (and extra env) and collect how it exited. */
function cli(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    const child = spawn('bun', [ENTRY, ...args], {
      env: {
        ...clean,
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
        ...env,
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

describe('flag ceilings (round-three T4)', () => {
  it('pins --port to the TCP range', () => {
    expect(parseArgs(['--port', String(MAX_PORT)]).port).toBe(MAX_PORT);
    expect(() => parseArgs(['--port', '65536'])).toThrow(
      `--port must be at most ${MAX_PORT}, got "65536"`,
    );
    expect(() => parseArgs(['--port', '70000'])).toThrow(/must be at most 65535/);
  });

  it('pins --concurrency to a sane slot count', () => {
    expect(parseArgs(['--concurrency', String(MAX_CONCURRENCY)]).concurrency).toBe(
      MAX_CONCURRENCY,
    );
    expect(() => parseArgs(['--concurrency', '1001'])).toThrow(
      `--concurrency must be at most ${MAX_CONCURRENCY}, got "1001"`,
    );
    // The original accident: parses as an integer, then Array.from({length})
    // dies (or OOMs) at claim-loop startup instead of at the flag.
    expect(() => parseArgs(['--concurrency', '1e9'])).toThrow(/must be at most 1000/);
  });

  it('refuses the env twins at the same bounds, at startup', async () => {
    const port = await cli([], { PORT: '70000' });
    expect(port.code).not.toBe(0);
    expect(`${port.stderr}${port.stdout}`).toMatch(/PORT must be at most 65535, got "70000"/);
    const conc = await cli([], { BETTER_TRIGGER_CONCURRENCY: '1e9' });
    expect(conc.code).not.toBe(0);
    expect(`${conc.stderr}${conc.stdout}`).toMatch(
      /BETTER_TRIGGER_CONCURRENCY must be at most 1000, got "1e9"/,
    );
  });

  it('names the next argument when a flag eats another flag', () => {
    expect(() => parseArgs(['--port', '--host', '0.0.0.0'])).toThrow(
      '--port got the flag "--host" where its value belongs',
    );
    // A genuinely missing value keeps the plain message.
    expect(() => parseArgs(['--port'])).toThrow('--port requires a value');
  });
});

describe('--help answers before the environment is read (round-three T5)', () => {
  it('a typo\'d PORT cannot stop --help from printing usage and exiting 0', async () => {
    const run = await cli(['--help'], { PORT: 'abc' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage:');
  });

  it('a broken BETTER_TRIGGER_NAMESPACES cannot stop prune --help', async () => {
    const run = await cli(['prune', '--help'], { BETTER_TRIGGER_NAMESPACES: 'garbage' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('prune');
  });

  it('without --help, a broken env still fails at startup', async () => {
    const run = await cli([], { PORT: 'abc' });
    expect(run.code).not.toBe(0);
    expect(`${run.stderr}${run.stdout}`).toMatch(/PORT must be a positive integer, got "abc"/);
  });
});

describe('--database-url credentials warning (round-three T7)', () => {
  it('detects credentials in the URL userinfo only', () => {
    expect(urlHasCredentials('postgres://user:pass@localhost:5432/db')).toBe(true);
    // A user without a password leaks nothing; a bare host:port is no
    // userinfo either. Unparseable values stay the driver's problem.
    expect(urlHasCredentials('postgres://user@localhost:5432/db')).toBe(false);
    expect(urlHasCredentials('postgres://localhost:5432/db')).toBe(false);
    expect(urlHasCredentials('not a url')).toBe(false);
  });

  it('warns once when the daemon flag value carries credentials', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const opts = parseArgs([
        '--database-url',
        'postgres://u:p@h/db',
        '--database-url',
        'postgres://u2:p2@h/db',
      ]);
      expect(opts.databaseUrl).toBe('postgres://u2:p2@h/db');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toMatch(
        /prefer the DATABASE_URL environment variable/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('stays silent for credential-free values, and warns for prune\'s', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const clean = parseArgs(['--database-url', 'postgres://localhost:5432/db']);
      expect(clean.databaseUrl).toBe('postgres://localhost:5432/db');
      const cleanPrune = parsePruneArgs([
        '--older-than',
        '30d',
        '--database-url',
        'postgres://user@localhost:5432/db',
      ]);
      expect(cleanPrune.databaseUrl).toBe('postgres://user@localhost:5432/db');
      expect(spy).not.toHaveBeenCalled();

      const leaky = parsePruneArgs(['--older-than', '30d', '--database-url', 'postgres://u:p@h/db']);
      expect(leaky.databaseUrl).toBe('postgres://u:p@h/db');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});