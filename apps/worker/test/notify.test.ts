/* =============================================================================
   @better-trigger/worker — LISTEN connection lifecycle (PF2,
   todos/02-performance.md): the failures that must never take the daemon down
   and must never leak connections.

   createNotifyListener takes an injectable client factory, so a fake client
   class can drive the failure modes a live server would:

     1. a connect/LISTEN failure must close the broken client (no socket leak)
        and retry with backoff;
     2. 'error' + the 'end' that usually follows must schedule exactly ONE
        reconnect — the dedup flag is what makes an unstable link cost one
        connection attempt, not two;
     3. a healthy connection dispatches parsed payloads to onNotify and drops
        malformed ones.
   ============================================================================= */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  createNotifyListener,
  NOTIFY_CHANNEL,
  type NotifyLogger,
  type NotifyPayload,
} from '../src/notify';
import { createNotifyCounters, type NotifyCounters } from '../src/observability';

const quiet: NotifyLogger = { warn: () => {}, error: () => {}, info: () => {} };

/** Fake pg.Client: records connect/end, and lets a test drive its events. */
class FakeClient {
  static instances: FakeClient[] = [];

  connects = 0;
  ended = 0;
  failConnect = false;
  failListen = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor() {
    FakeClient.instances.push(this);
  }

  async connect(): Promise<void> {
    this.connects += 1;
    if (this.failConnect) throw new Error('connect refused');
  }

  async query(text: string): Promise<unknown> {
    if (this.failListen) throw new Error('LISTEN failed');
    void text;
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended += 1;
    this.emit('end');
  }

  has(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? [];
    set.push(listener);
    this.listeners.set(event, set);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function makeListener(opts: {
  onNotify?: (p: NotifyPayload) => void;
  failConnect?: boolean;
  failListenOnce?: boolean;
  reconnectBaseMs?: number;
  counters?: NotifyCounters;
}): { listener: ReturnType<typeof createNotifyListener>; onNotify: ReturnType<typeof vi.fn>; counters: NotifyCounters } {
  FakeClient.instances = [];
  const counters = opts.counters ?? createNotifyCounters();
  const onNotify = vi.fn(opts.onNotify ?? (() => {}));
  const listener = createNotifyListener({
    connectionString: 'postgres://test',
    logger: quiet,
    counters,
    onNotify,
    reconnectBaseMs: opts.reconnectBaseMs ?? 10,
    createClient: () => {
      const fake = new FakeClient();
      fake.failConnect = opts.failConnect ?? false;
      // The constructor already pushed this client, so the first one sees
      // instances.length === 1 at check time.
      if (opts.failListenOnce && FakeClient.instances.length === 1) fake.failListen = true;
      return fake as unknown as pg.Client;
    },
  });
  return { listener, onNotify, counters };
}

const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('LISTEN connection lifecycle', () => {
  it('closes a client whose connect failed (no socket leak) and retries', async () => {
    const { listener, counters } = makeListener({ failConnect: true, reconnectBaseMs: 10 });
    try {
      await waitFor(() => FakeClient.instances.length >= 3); // initial + retries
      // Every broken client must have been closed by the connect failure path.
      for (const c of FakeClient.instances) expect(c.ended).toBe(1);
      expect(counters.listenReconnects).toBeGreaterThanOrEqual(2);
    } finally {
      await listener.stop();
    }
  });

  it('closes a client whose LISTEN statement failed and retries', async () => {
    const { listener, counters } = makeListener({ failListenOnce: true, reconnectBaseMs: 10 });
    try {
      // The first client connects but fails to LISTEN: same cleanup path, and
      // the retry produces a healthy client.
      await waitFor(() => FakeClient.instances.length >= 2);
      expect(FakeClient.instances[0]!.ended).toBe(1);
      expect(FakeClient.instances[1]!.ended).toBe(0);
      expect(counters.listenReconnects).toBeGreaterThanOrEqual(1);
    } finally {
      await listener.stop();
    }
  });

  it("'error' followed by 'end' schedules exactly one reconnect", async () => {
    const { listener, counters } = makeListener({ reconnectBaseMs: 10 });
    try {
      await waitFor(
        () =>
          FakeClient.instances.length === 1 &&
          FakeClient.instances[0]!.connects === 1 &&
          FakeClient.instances[0]!.has('end'), // event handlers are attached after connect
      );
      const first = FakeClient.instances[0]!;
      first.emit('error', new Error('connection reset'));
      first.emit('end'); // the 'end' pg usually emits after 'error'
      await waitFor(() => FakeClient.instances.length >= 2);
      await new Promise((r) => setTimeout(r, 30)); // past the retry backoff
      // One retry, not two: the error/end pair deduped into one reconnect.
      expect(FakeClient.instances.length).toBe(2);
      expect(counters.listenReconnects).toBe(1);
    } finally {
      await listener.stop();
    }
  });

  it("an 'error' with no following 'end' still reconnects", async () => {
    const { listener, counters } = makeListener({ reconnectBaseMs: 10 });
    try {
      await waitFor(
        () =>
          FakeClient.instances.length === 1 &&
          FakeClient.instances[0]!.connects === 1 &&
          FakeClient.instances[0]!.has('end'),
      );
      FakeClient.instances[0]!.emit('error', new Error('connection reset'));
      await waitFor(() => FakeClient.instances.length >= 2);
      expect(counters.listenReconnects).toBe(1);
    } finally {
      await listener.stop();
    }
  });

  it('dispatches parsed payloads and drops malformed ones', async () => {
    const { listener, onNotify } = makeListener({});
    try {
      await waitFor(
        () =>
          FakeClient.instances.length === 1 &&
          FakeClient.instances[0]!.connects === 1 &&
          FakeClient.instances[0]!.has('notification'),
      );
      const client = FakeClient.instances[0]!;
      client.emit('notification', { channel: NOTIFY_CHANNEL, payload: '{"type":"work"}' });
      client.emit('notification', {
        channel: NOTIFY_CHANNEL,
        payload: '{"type":"terminal","runId":"run_1","projectId":"default","env":"prod"}',
      });
      // Wrong channel, bad JSON and wrong shape must all be dropped.
      client.emit('notification', { channel: 'other', payload: '{"type":"work"}' });
      client.emit('notification', { channel: NOTIFY_CHANNEL, payload: 'not json' });
      client.emit('notification', { channel: NOTIFY_CHANNEL, payload: '{"type":"terminal"}' });
      await waitFor(() => onNotify.mock.calls.length >= 2);
      expect(onNotify.mock.calls).toEqual([
        [{ type: 'work' }],
        [{ type: 'terminal', runId: 'run_1', projectId: 'default', env: 'prod' }],
      ]);
    } finally {
      await listener.stop();
    }
  });

  it('stop() closes the live client and no reconnect follows', async () => {
    const { listener, counters } = makeListener({ reconnectBaseMs: 10 });
    await waitFor(() => FakeClient.instances.length === 1 && FakeClient.instances[0]!.connects === 1);
    const live = FakeClient.instances[0]!;
    await listener.stop();
    expect(live.ended).toBe(1);
    const reconnects = counters.listenReconnects;
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeClient.instances.length).toBe(1); // nothing reconnected
    expect(counters.listenReconnects).toBe(reconnects);
  });
});
