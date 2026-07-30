/* =============================================================================
   @better-trigger/worker — listen posture (CLI) tests.

   The daemon serves an API that triggers tasks and hands back run payloads, and
   it is unauthenticated unless BETTER_TRIGGER_API_KEY is set. So the bind
   address is a security decision: loopback by default, and a non-loopback
   --host without a key must refuse to start rather than warn.

   Driven through the real CLI (spawned under bun) because that is where the
   decision lives; the check runs before any Postgres connection, so these need
   no database — the escape-hatch case is only asked to get PAST the check.

   The last block is the one that matters most: the CLI can parse --host
   perfectly and still hand serve() nothing, in which case Node binds every
   interface and every test above stays green. So it opens a real socket through
   the daemon's own listen wiring and reads back the address it bound to.
   ============================================================================= */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/listen';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface Run {
  code: number | null;
  out: string;
}

/**
 * Runs the CLI, killing it if it survives long enough to start booting. `until`
 * kills it as soon as the output matches, for the cases that boot on purpose
 * and would otherwise sit there until the 10s backstop.
 */
function runCli(
  args: string[],
  env: Record<string, string> = {},
  until?: RegExp,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    delete clean.BETTER_TRIGGER_HOST;
    delete clean.BETTER_TRIGGER_ALLOW_UNAUTHENTICATED;
    const child = spawn('bun', [MAIN, ...args], {
      env: {
        ...clean,
        // Nothing listens here: getting this far already proves the posture
        // check let the process through.
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const collect = (d: Buffer): void => {
      out += d.toString();
      if (until?.test(out)) child.kill('SIGKILL');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const TIMEOUT = 30_000;

describe('listen posture', () => {
  it(
    'documents --host in the usage text',
    async () => {
      const { code, out } = await runCli(['--help']);
      expect(code).toBe(0);
      expect(out).toContain('--host <addr>');
      expect(out).toContain('--allow-unauthenticated');
      expect(out).toContain('127.0.0.1');
    },
    TIMEOUT,
  );

  it(
    'refuses a non-loopback --host when no API key is set',
    async () => {
      const { code, out } = await runCli(['--host', '0.0.0.0']);
      expect(code).toBe(1);
      expect(out).toContain('BETTER_TRIGGER_API_KEY');
      expect(out).toContain('--allow-unauthenticated');
    },
    TIMEOUT,
  );

  it(
    'allows a non-loopback --host once an API key is set',
    async () => {
      const { out } = await runCli(['--host', '0.0.0.0'], {
        BETTER_TRIGGER_API_KEY: 'secret',
      });
      expect(out).not.toContain('--allow-unauthenticated');
    },
    TIMEOUT,
  );

  it(
    'allows --allow-unauthenticated as the explicit override',
    async () => {
      const { out } = await runCli(['--host', '0.0.0.0', '--allow-unauthenticated']);
      expect(out).not.toContain('exposes the API to the network');
    },
    TIMEOUT,
  );

  it(
    'accepts loopback aliases without an API key',
    async () => {
      for (const host of ['localhost', '::1', '127.0.0.2']) {
        const { out } = await runCli(['--host', host]);
        expect(out, host).not.toContain('exposes the API to the network');
      }
    },
    TIMEOUT,
  );

  it(
    'does not refuse the default loopback bind',
    async () => {
      const { out } = await runCli([]);
      expect(out).not.toContain('exposes the API to the network');
    },
    TIMEOUT,
  );

  it(
    'names the env var too — a container cannot be given CLI flags',
    async () => {
      const { code, out } = await runCli(['--host', '0.0.0.0']);
      expect(code).toBe(1);
      expect(out).toContain('BETTER_TRIGGER_ALLOW_UNAUTHENTICATED');
    },
    TIMEOUT,
  );

  it(
    'reads --allow-unauthenticated=false as false, not as "flag present"',
    async () => {
      const { code, out } = await runCli([
        '--host',
        '0.0.0.0',
        '--allow-unauthenticated=false',
      ]);
      expect(code).toBe(1);
      expect(out).toContain('exposes the API to the network');

      const on = await runCli(['--host', '0.0.0.0', '--allow-unauthenticated=1']);
      expect(on.out).not.toContain('exposes the API to the network');
    },
    TIMEOUT,
  );

  it(
    'treats BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=false as off',
    async () => {
      const { code, out } = await runCli(['--host', '0.0.0.0'], {
        BETTER_TRIGGER_ALLOW_UNAUTHENTICATED: 'false',
      });
      expect(code).toBe(1);
      expect(out).toContain('exposes the API to the network');
    },
    TIMEOUT,
  );

  it(
    'does not mistake a hostname that merely starts with 127. for loopback',
    async () => {
      const { code, out } = await runCli(['--host', '127.0.0.1.evil.example']);
      expect(code).toBe(1);
      expect(out).toContain('exposes the API to the network');
    },
    TIMEOUT,
  );
});

/*
 * S3's other half: unauthenticated-by-default is a deliberate product choice,
 * so the one thing it owes the operator is being said out loud at boot. These
 * have to reach the log line, which sits after the HTTP server comes up —
 * --no-migrate is what gets them past the database with nothing listening.
 */
describe('unauthenticated startup notice', () => {
  /** An OS-assigned port, released before the CLI is handed it. */
  async function freePort(): Promise<string> {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return String(port);
  }

  it(
    'says so, with the address it applies to',
    async () => {
      const { out } = await runCli(
        ['--port', await freePort(), '--no-migrate'],
        {},
        /API is unauthenticated/,
      );
      expect(out).toContain('anything on this machine can call it');
      expect(out).toContain('bound to 127.0.0.1');
      expect(out).toContain('BETTER_TRIGGER_API_KEY');
    },
    TIMEOUT,
  );

  it(
    'stays quiet once a key is set',
    async () => {
      const { out } = await runCli(
        ['--port', await freePort(), '--no-migrate'],
        { BETTER_TRIGGER_API_KEY: 'secret' },
        /listening on/,
      );
      expect(out).not.toContain('API is unauthenticated');
    },
    TIMEOUT,
  );
});

describe('bind address', () => {
  const open: { close(cb?: () => void): void }[] = [];

  afterEach(async () => {
    await Promise.all(
      open.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  /** Brings the daemon's listen wiring up on an OS-assigned port. */
  async function bind(host: string): Promise<AddressInfo> {
    const app = new Hono();
    app.get('/ping', (c) => c.text('pong'));
    return await new Promise<AddressInfo>((resolve, reject) => {
      const server = startHttpServer(app, { port: 0, host }, (info) => resolve(info));
      open.push(server);
      server.on('error', reject);
    });
  }

  it('binds loopback only when asked for 127.0.0.1', async () => {
    const info = await bind('127.0.0.1');
    // Not `expect(...).not.toBe('0.0.0.0')`: dropping the hostname makes Node
    // listen on '::' (or '0.0.0.0'), and this is what catches both.
    expect(info.address).toBe('127.0.0.1');
    expect(info.family).toBe('IPv4');

    const res = await fetch(`http://127.0.0.1:${info.port}/ping`);
    expect(await res.text()).toBe('pong');
  });

  it('binds what --host asked for instead', async () => {
    const info = await bind('0.0.0.0');
    expect(info.address).toBe('0.0.0.0');

    const six = await bind('::1');
    expect(six.address).toBe('::1');
    expect(six.family).toBe('IPv6');
  });
});
