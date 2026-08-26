/* =============================================================================
   @better-trigger/worker — startup validation of PORT and
   BETTER_TRIGGER_CONCURRENCY (todos/p0-01-concurrency-env-validation.md).

   Both envs fall back through parsePositiveIntEnv, which requires a positive
   *integer* when set. The reason is a safety property: concurrency feeds
   `Array.from({ length })`, so a typo'd value would otherwise start a daemon
   that serves the API but claims nothing, silently. And PORT must fail at
   parse time, not blow up later inside listen().

   Driven through the real CLI (spawned under bun), because the parser is
   reached through main(). An unreachable DATABASE_URL proves the refusal lands
   DURING parsing, before anything connects; the valid case is read off the
   boot banner with --no-migrate (same trick as namespace-cli.test.ts).
   ============================================================================= */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** An OS-assigned port, released before the CLI is handed it. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** Run the CLI and collect the exit. The database can never be reached. */
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
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += String(b)));
    child.stderr.on('data', (b) => (stderr += String(b)));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Boot a daemon far enough to print its namespace banner, then kill it. */
async function bootedBanner(env?: Record<string, string>): Promise<string> {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    const child = spawn('bun', [ENTRY, '--no-migrate', '--port', String(port)], {
      env: {
        ...clean,
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    child.stdout.on('data', (b) => (out += String(b)));
    child.stderr.on('data', (b) => (out += String(b)));
    child.on('error', reject);
    const timer = setTimeout(() => reject(new Error(`daemon never booted:\n${out}`)), 20_000);
    const probe = setInterval(() => {
      if (out.includes('serving namespace(s):')) {
        clearTimeout(timer);
        clearInterval(probe);
        child.kill('SIGKILL');
        resolve(out);
      }
    }, 50);
  });
}

describe('BETTER_TRIGGER_CONCURRENCY validation', () => {
  it('refuses a non-numeric value instead of silently claiming nothing', async () => {
    const run = await cli([], { BETTER_TRIGGER_CONCURRENCY: 'abc' });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/BETTER_TRIGGER_CONCURRENCY must be a positive integer, got "abc"/);
  }, 20_000);

  it('refuses a zero value', async () => {
    const run = await cli([], { BETTER_TRIGGER_CONCURRENCY: '0' });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/BETTER_TRIGGER_CONCURRENCY must be a positive integer, got "0"/);
  }, 20_000);

  it('refuses a negative value', async () => {
    const run = await cli([], { BETTER_TRIGGER_CONCURRENCY: '-1' });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/BETTER_TRIGGER_CONCURRENCY must be a positive integer, got "-1"/);
  }, 20_000);

  it('refuses a fractional value', async () => {
    const run = await cli([], { BETTER_TRIGGER_CONCURRENCY: '2.5' });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/BETTER_TRIGGER_CONCURRENCY must be a positive integer, got "2.5"/);
  }, 20_000);

  it('accepts a positive integer and boots', async () => {
    const out = await bootedBanner({ BETTER_TRIGGER_CONCURRENCY: '5' });
    expect(out).toContain('serving namespace(s): default/prod');
  }, 25_000);
});

describe('PORT validation', () => {
  it('refuses a non-numeric value instead of failing later in listen()', async () => {
    const run = await cli([], { PORT: 'abc' });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/PORT must be a positive integer, got "abc"/);
  }, 20_000);
});