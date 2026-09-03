/* =============================================================================
   @better-trigger/testing — daemon lifecycle unit tests (T1/T2 acceptance).

   node:child_process is mocked: these test the harness's promises (error
   propagation, timer cleanup, orphan killing, health probing), not bun.
   ============================================================================= */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { spawnDaemon, startDaemon, waitForHealth, type Daemon } from '../src/daemon';

class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  exitsOnTerm = false;
  exitsOnKill = true;

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if ((signal === 'SIGKILL' && this.exitsOnKill) || this.exitsOnTerm) this.exit();
    return true;
  }

  exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

let proc: FakeProc;
let daemon: Daemon;

beforeEach(() => {
  proc = new FakeProc();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('spawnDaemon', () => {
  it('throws a clear error when serving without a port (no "--port undefined")', () => {
    expect(() => spawnDaemon({ databaseUrl: 'postgres://x/y' })).toThrow(/`port` is required/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('surfaces spawn failures to waiters instead of process.exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    proc.exitsOnKill = false; // a process that never started cannot be signalled away
    daemon = spawnDaemon({ databaseUrl: 'postgres://x/y', port: 4101 });
    proc.emit('error', new Error('spawn bun ENOENT'));
    await expect(daemon.kill()).rejects.toThrow('failed to spawn worker daemon: spawn bun ENOENT');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('Daemon.stop', () => {
  it('clears the grace timer when the process exits first', async () => {
    vi.useFakeTimers();
    daemon = spawnDaemon({ databaseUrl: 'postgres://x/y', port: 4102 });
    const stopping = daemon.stop(10_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(1); // grace timer pending while it stays up
    proc.exit();
    await stopping;
    expect(vi.getTimerCount()).toBe(0); // the loser of the race must not pin the loop
    expect(proc.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL once the grace period passes', async () => {
    vi.useFakeTimers();
    daemon = spawnDaemon({ databaseUrl: 'postgres://x/y', port: 4103 });
    const stopping = daemon.stop(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('waitForHealth', () => {
  it('returns within timeoutMs against a black-hole connection (accepts, never answers)', async () => {
    const fetches = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetches);
    const t0 = Date.now();
    await expect(waitForHealth('http://127.0.0.1:4109', 400)).rejects.toThrow(
      /timed out after 400ms waiting for: daemon at/,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000); // bounded by timeoutMs + one poll tick, not forever
    expect(fetches).toHaveBeenCalled();
  });

  it('resolves as soon as health answers ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    await waitForHealth('http://127.0.0.1:4110', 1_000);
  });
});

describe('startDaemon', () => {
  it('kills the child and propagates the failure when health never comes up', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const starting = startDaemon({ databaseUrl: 'postgres://x/y', port: 4111 });
    const rejected = expect(starting).rejects.toThrow(/timed out after 30000ms/);
    await vi.advanceTimersByTimeAsync(31_000);
    await rejected;
    expect(proc.signals).toContain('SIGKILL'); // no orphan left behind
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the daemon once health answers', async () => {
    proc.exitsOnTerm = false;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    daemon = await startDaemon({ databaseUrl: 'postgres://x/y', port: 4112 });
    expect(daemon.url).toBe('http://localhost:4112');
    proc.exit();
  });
});
