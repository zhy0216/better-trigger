/* =============================================================================
   @better-trigger/db — pool error-handling unit tests. No live Postgres: a pg
   Pool connects lazily, so a pool can be created and driven without a server.
   What is under test is the EventEmitter contract, not SQL — an 'error' with no
   listener is rethrown by Node as an uncaught exception, and the daemon this
   pool belongs to runs on laptops that sleep, so that path is not theoretical.
   ============================================================================= */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createHealthPool, createPool } from '../src/pool';

const execFileAsync = promisify(execFile);
const UNREACHABLE = 'postgres://better_trigger@127.0.0.1:1/none';

describe('createPool — idle client errors', () => {
  it('is a fatal throw without the listener (the trap being guarded)', async () => {
    const bare = new pg.Pool({ connectionString: UNREACHABLE });
    expect(() => bare.emit('error', new Error('boom'))).toThrow('boom');
    await bare.end();
  });

  it('swallows the throw and reports to the logger instead', async () => {
    const logged: unknown[][] = [];
    const pool = createPool(UNREACHABLE, { error: (...args) => logged.push(args) });

    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['[better-trigger] idle client error:', 'boom']);

    await pool.end();
  });

  it('defaults the logger to console', async () => {
    const pool = createPool(UNREACHABLE);
    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    await pool.end();
  });

  it('forwards max / connectionTimeoutMillis / statementTimeoutMs to pg', async () => {
    const pool = createPool(UNREACHABLE, { error: () => {} }, {
      max: 3,
      connectionTimeoutMillis: 1500,
      statementTimeoutMs: 30_000,
    });
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(1500);
    // node-postgres maps this to the `statement_timeout` startup-packet config,
    // exactly as createHealthPool does for its probe pool.
    expect(pool.options.statement_timeout).toBe(30_000);
    await pool.end();
  });

  it('leaves pg defaults alone when an option is undefined', async () => {
    const pool = createPool(UNREACHABLE, { error: () => {} }, { max: 7 });
    expect(pool.options.max).toBe(7);
    // Not passed → keys absent from the config pg receives, so its own
    // defaults stand (connectionTimeoutMillis 0 = wait forever, no timeout).
    expect(pool.options.connectionTimeoutMillis).toBeUndefined();
    expect(pool.options.statement_timeout).toBeUndefined();
    await pool.end();
  });

  it('calls onError alongside the logger on an idle client error', async () => {
    const onErrors: Error[] = [];
    const pool = createPool(UNREACHABLE, { error: () => {} }, {
      onError: (err) => onErrors.push(err),
    });

    const boom = new Error('boom');
    expect(() => pool.emit('error', boom)).not.toThrow();
    expect(onErrors).toEqual([boom]);

    await pool.end();
  });

  it('keeps the pool usable — the bad client is dropped, not the pool', async () => {
    const pool = createPool(UNREACHABLE, { error: () => {} });
    pool.emit('error', new Error('boom'));
    expect(pool.ended).toBe(false);
    await pool.end();
  });
});

describe('createHealthPool — probe pool config (PF4)', () => {
  it('caps probe connections at 2, whatever the business pool does', async () => {
    const pool = createHealthPool(UNREACHABLE, { error: () => {} });
    expect(pool.options.max).toBe(2);
    await pool.end();
  });

  it('arms a server-side statement_timeout so a hung probe query is cancelled', async () => {
    // node-postgres sends statement_timeout as `-c statement_timeout=...` in
    // the connection startup packet: PostgreSQL itself cancels the query after
    // this and the connection returns to the pool. It must sit below the
    // routes' 2s HTTP deadline (todos/02-performance.md PF4).
    const pool = createHealthPool(UNREACHABLE, { error: () => {} });
    expect(pool.options.statement_timeout).toBe(1000);
    await pool.end();
  });

  it('arms a connection-establishment timeout for a black-holed network', async () => {
    const pool = createHealthPool(UNREACHABLE, { error: () => {} });
    expect(pool.options.connectionTimeoutMillis).toBe(1000);
    await pool.end();
  });

  it('attaches the same idle-client error listener as the business pool', async () => {
    const logged: unknown[][] = [];
    const pool = createHealthPool(UNREACHABLE, { error: (...args) => logged.push(args) });

    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['[better-trigger] idle client error:', 'boom']);
    expect(pool.ended).toBe(false);

    await pool.end();
  });
});

/* Node runs .ts sources directly via type stripping, on by default since 22.18
   / 23.6. Below that the child cannot load src/ without a build step, and the
   in-process assertions above have to stand on their own. */
const [major, minor] = process.versions.node.split('.').map(Number);
const canStripTypes = (major ?? 0) >= 23 || (major === 22 && (minor ?? 0) >= 18);

describe.skipIf(!canStripTypes)('createPool — in a real process', () => {
  it('survives an idle client error raised outside any try/catch', async () => {
    const child = fileURLToPath(new URL('./fixtures/idle-error-child.mjs', import.meta.url));
    // Rejects on a non-zero exit, which is precisely the regression: before the
    // listener existed this child died with code 1 on the unhandled 'error'.
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', child],
      { timeout: 20_000 },
    );

    expect(stdout).toContain('SURVIVED');
    expect(stderr).toContain('[better-trigger] idle client error: boom');
  }, 30_000);
});
