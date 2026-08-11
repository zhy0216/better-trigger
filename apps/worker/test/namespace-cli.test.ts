/* =============================================================================
   @better-trigger/worker — CLI namespace parsing (C2 host boundary).

   `--namespace <projectId>/<env>` / BETTER_TRIGGER_NAMESPACES decide which
   namespaces a daemon serves — the single most load-bearing configuration the
   process has, since it gates claim/register/orchestrator scope. So its
   parsing is a safety property like prune's: a malformed spec must refuse to
   start rather than silently serve the wrong namespace, and a daemon
   configured for nothing must serve exactly default/prod — never every
   namespace at once.

   Driven through the real CLI (spawned under bun). Parse failures exit during
   parsing, before anything connects — an unreachable DATABASE_URL is proof of
   exactly that. Valid parses are read off the boot banner
   (`serving namespace(s): ...`), which the daemon prints after booting; the
   unreachable database plus --no-migrate lets it come fully up (same trick as
   host.test.ts).
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
async function bootedBanner(args: string[], env?: Record<string, string>): Promise<string> {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    const child = spawn('bun', [ENTRY, '--no-migrate', '--port', String(port), ...args], {
        env: {
          ...clean,
          DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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

describe('--namespace parsing', () => {
  it('defaults to default/prod when nothing is configured', async () => {
    const out = await bootedBanner([]);
    expect(out).toContain('serving namespace(s): default/prod');
  }, 25_000);

  it('serves exactly the namespaces listed (repeatable flag)', async () => {
    const out = await bootedBanner(['--namespace', 'acme/prod', '--namespace', 'acme/staging']);
    expect(out).toContain('serving namespace(s): acme/prod, acme/staging');
  }, 25_000);

  it('accepts a comma-separated value, deduped', async () => {
    const out = await bootedBanner(['--namespace', 'acme/prod,acme/staging,acme/prod']);
    expect(out).toContain('serving namespace(s): acme/prod, acme/staging');
  }, 25_000);

  it('reads BETTER_TRIGGER_NAMESPACES and lets flags append to it', async () => {
    const out = await bootedBanner(['--namespace', 'acme/staging'], {
      BETTER_TRIGGER_NAMESPACES: 'acme/prod',
    });
    expect(out).toContain('serving namespace(s): acme/prod, acme/staging');
  }, 25_000);

  it('refuses a spec without the / separator', async () => {
    const run = await cli(['--namespace', 'acme']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/--namespace must be "<projectId>\/<env>"/);
  }, 20_000);

  it('refuses an empty half of the pair', async () => {
    const run = await cli(['--namespace', 'acme/']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/--namespace must be "<projectId>\/<env>"/);
  }, 20_000);

  it('refuses a namespace part that would collide on the advisory lock key', async () => {
    // ':' separates the concurrency-limiter lock key (bt:cc:projectId:env:key),
    // so it must never pass the parser.
    const run = await cli(['--namespace', 'ac:me/prod']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/must not contain ':'/);
  }, 20_000);

  it('applies the same rules to BETTER_TRIGGER_NAMESPACES', async () => {
    const run = await cli([], { BETTER_TRIGGER_NAMESPACES: 'broken' });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/must be "<projectId>\/<env>"/);
  }, 20_000);

  it('prune accepts and scopes to --namespace', async () => {
    // A prune with a bogus namespace must refuse before it can delete anything.
    const run = await cli(['prune', '--older-than', '30d', '--namespace', 'oops']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/must be "<projectId>\/<env>"/);
  }, 20_000);
});

describe('--help', () => {
  it('documents --namespace and its env twin', async () => {
    const run = await cli(['--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/--namespace <projectId>\/<env>/);
    expect(run.stdout).toMatch(/BETTER_TRIGGER_NAMESPACES/);
  }, 20_000);
});
