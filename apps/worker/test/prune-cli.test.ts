/* =============================================================================
   @better-trigger/worker — the `prune` subcommand's argument handling
   (todos/02-performance.md PF6).

   `better-trigger-worker prune` deletes history, so everything about how it
   reads its flags is a safety property: a missing window must not fall back to
   one, a typo must not be silently ignored, and `--dry-run=false` has to be
   understood rather than treated as "the flag is present, therefore true".

   Driven through the real CLI (spawned under bun), because the parser is
   reached through `main()` and only a process can show that the refusal happens
   BEFORE anything connects. Every case here fails during parsing, so an
   unreachable DATABASE_URL is proof of exactly that: if any of them ever got
   past the parser, the run would hang on a connection instead of exiting.
   ============================================================================= */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
        // Nothing listens here. A case that reached the database would stall on
        // the connect rather than exiting, which the timeout would then catch.
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += String(b)));
    child.stderr.on('data', (b) => (stderr += String(b)));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('better-trigger-worker prune', () => {
  it('refuses to pick a retention window for you', async () => {
    const run = await cli(['prune']);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/--older-than/);
  }, 20_000);

  it('rejects a bare number: 30 must not quietly mean 30 milliseconds', async () => {
    const run = await cli(['prune', '--older-than', '30']);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/--older-than/);
    expect(run.stderr).toMatch(/invalid duration/);
  }, 20_000);

  it('reports an unknown flag instead of ignoring it', async () => {
    const run = await cli(['prune', '--older-than=30d', '--older-then=7d']);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/unknown option "--older-then"/);
  }, 20_000);

  it('prints its own help, not the daemon usage', async () => {
    const run = await cli(['prune', '--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/prune — delete history past a retention window/);
    expect(run.stdout).toMatch(/--dry-run/);
    // The daemon's flags have no business in it.
    expect(run.stdout).not.toMatch(/--concurrency/);
  }, 20_000);

  it('mentions the subcommand in the daemon usage', async () => {
    const run = await cli(['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/prune --older-than/);
    expect(run.stdout).toMatch(/--retention <duration>/);
  }, 20_000);

  it('refuses `--dry-run=maybe` rather than resolving it towards deleting', async () => {
    const run = await cli(['prune', '--older-than=30d', '--dry-run=maybe']);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/--dry-run must be true or false/);
  }, 20_000);
});
