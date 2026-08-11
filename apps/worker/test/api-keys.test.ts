/* =============================================================================
   @better-trigger/worker — multi-key auth tests (O6).

   Auth accepts ANY configured key: BETTER_TRIGGER_API_KEY (the primary,
   unchanged behaviour) plus the comma-separated BETTER_TRIGGER_API_KEYS
   list. Each entry may carry a `@<date>` expiry suffix; an expired key is
   refused with a DISTINCT code (`key_expired`) so the audit trail says why a
   credential stopped working. Rotation is the coexistence of old and new
   keys: add the new one, let old requests drain, remove the old one.

   Driven through createApp with stub deps — no Postgres involved.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { configuredApiKeys, keyFingerprint, matchApiKey, parseKeyEntry } from '../src/middleware';

const PRIMARY = 'sk-primary-aaaaaaaa';
const SECONDARY = 'sk-secondary-bbbbbbbb';
const TERTIARY = 'sk-tertiary-cccccccc';

const makeApp = () => {
  const kernel = {
    trigger: async () => ({ runId: 'run_1', idempotent: false }),
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return createApp({ kernel, pool });
};

const trigger = (auth?: string) =>
  new Request('http://localhost:4848/api/v1/trigger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth !== undefined ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ taskId: 't', payload: null }),
  });

let savedPrimary: string | undefined;
let savedExtras: string | undefined;

beforeEach(() => {
  savedPrimary = process.env.BETTER_TRIGGER_API_KEY;
  savedExtras = process.env.BETTER_TRIGGER_API_KEYS;
  process.env.BETTER_TRIGGER_API_KEY = PRIMARY;
  delete process.env.BETTER_TRIGGER_API_KEYS;
});

afterEach(() => {
  if (savedPrimary === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedPrimary;
  if (savedExtras === undefined) delete process.env.BETTER_TRIGGER_API_KEYS;
  else process.env.BETTER_TRIGGER_API_KEYS = savedExtras;
});

describe('parseKeyEntry', () => {
  it('keeps a bare key whole', () => {
    expect(parseKeyEntry('sk-abc')).toEqual({ key: 'sk-abc', expiresAt: null });
  });

  it('splits a valid @date suffix and parses it', () => {
    const entry = parseKeyEntry('sk-old@2030-01-02');
    expect(entry.key).toBe('sk-old');
    expect(entry.expiresAt).toBe(new Date('2030-01-02').getTime());
  });

  it('accepts a full ISO datetime suffix', () => {
    const entry = parseKeyEntry('sk-old@2030-01-02T00:00:00Z');
    expect(entry.key).toBe('sk-old');
    expect(entry.expiresAt).toBe(new Date('2030-01-02T00:00:00Z').getTime());
  });

  it('keeps a key whole when the suffix is not a date', () => {
    expect(parseKeyEntry('sk-a@b')).toEqual({ key: 'sk-a@b', expiresAt: null });
    expect(parseKeyEntry('sk-a@')).toEqual({ key: 'sk-a@', expiresAt: null });
  });

  it('only treats the last @ as the separator', () => {
    expect(parseKeyEntry('sk@weird@2031-06-01')).toEqual({
      key: 'sk@weird',
      expiresAt: new Date('2031-06-01').getTime(),
    });
  });
});

describe('configuredApiKeys', () => {
  it('collects the primary and the extras in order, trimming blanks', () => {
    process.env.BETTER_TRIGGER_API_KEYS = ' a , b , , c ';
    expect(configuredApiKeys().map((e) => e.key)).toEqual([PRIMARY, 'a', 'b', 'c']);
  });

  it('is empty when nothing is configured', () => {
    delete process.env.BETTER_TRIGGER_API_KEY;
    process.env.BETTER_TRIGGER_API_KEYS = ' , ';
    expect(configuredApiKeys()).toEqual([]);
  });

  it('parses expiry suffixes on extra keys too', () => {
    process.env.BETTER_TRIGGER_API_KEYS = `sk-x@2032-01-01, sk-y`;
    const entries = configuredApiKeys();
    // [PRIMARY, sk-x@2032-01-01, sk-y]
    expect(entries[1]!.expiresAt).toBe(new Date('2032-01-01').getTime());
    expect(entries[2]!.expiresAt).toBeNull();
  });
});

describe('matchApiKey', () => {
  it('finds the first exact match, comparing against every entry', () => {
    process.env.BETTER_TRIGGER_API_KEYS = `${SECONDARY},${TERTIARY}`;
    const entries = configuredApiKeys();
    expect(matchApiKey(SECONDARY, entries)?.key).toBe(SECONDARY);
    expect(matchApiKey(PRIMARY, entries)?.key).toBe(PRIMARY);
    expect(matchApiKey(TERTIARY, entries)?.key).toBe(TERTIARY);
    expect(matchApiKey('nope', entries)).toBeNull();
  });
});

describe('multi-key bearer auth', () => {
  it('accepts any configured key', async () => {
    process.env.BETTER_TRIGGER_API_KEYS = `${SECONDARY},${TERTIARY}`;
    const app = makeApp();
    for (const key of [PRIMARY, SECONDARY, TERTIARY]) {
      const res = await app.fetch(trigger(`Bearer ${key}`));
      expect(res.status, key).toBe(200);
    }
  });

  it('rejects a key that is not configured, unchanged from the single-key shape', async () => {
    process.env.BETTER_TRIGGER_API_KEYS = SECONDARY;
    const app = makeApp();
    const res = await app.fetch(trigger(`Bearer sk-nope-000000000000`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'invalid or missing API key' },
    });
  });

  it('keeps /health open regardless of key state', async () => {
    process.env.BETTER_TRIGGER_API_KEYS = SECONDARY;
    const res = await makeApp().fetch(new Request('http://localhost:4848/api/v1/health'));
    expect(res.status).toBe(200);
  });

  it('is still a no-op when no key at all is configured', async () => {
    delete process.env.BETTER_TRIGGER_API_KEY;
    process.env.BETTER_TRIGGER_API_KEYS = '';
    const app = makeApp();
    expect((await app.fetch(trigger())).status).toBe(200);
    expect((await app.fetch(trigger('Bearer whatever'))).status).toBe(200);
  });
});

describe('key rotation', () => {
  it('old and new keys coexist during the rotation window, then the old one stops working', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-old-111111111111';
    process.env.BETTER_TRIGGER_API_KEYS = 'sk-new-222222222222';
    const app = makeApp();
    // Rotation window: both keys authenticate.
    expect((await app.fetch(trigger('Bearer sk-old-111111111111'))).status).toBe(200);
    expect((await app.fetch(trigger('Bearer sk-new-222222222222'))).status).toBe(200);
    // The old key is removed from config: it stops working, the new one does not.
    delete process.env.BETTER_TRIGGER_API_KEY;
    process.env.BETTER_TRIGGER_API_KEYS = 'sk-new-222222222222';
    expect((await app.fetch(trigger('Bearer sk-old-111111111111'))).status).toBe(401);
    expect((await app.fetch(trigger('Bearer sk-new-222222222222'))).status).toBe(200);
  });

  it('an expiry suffix makes the key refuse once past the date', async () => {
    process.env.BETTER_TRIGGER_API_KEY = `sk-old@2000-01-01`;
    process.env.BETTER_TRIGGER_API_KEYS = 'sk-new-333333333333';
    const app = makeApp();
    const oldKey = await app.fetch(trigger('Bearer sk-old'));
    expect(oldKey.status).toBe(401);
    const body = (await oldKey.json()) as { error: { code: string } };
    // A distinct code, so the audit log can say *why* (expired_key, not
    // unauthorized) — and the new key is unaffected.
    expect(body.error.code).toBe('key_expired');
    expect((await app.fetch(trigger('Bearer sk-new-333333333333'))).status).toBe(200);
  });

  it('a not-yet-expired key still authenticates', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-future@2999-01-01';
    const app = makeApp();
    expect((await app.fetch(trigger('Bearer sk-future'))).status).toBe(200);
  });
});

describe('keyFingerprint', () => {
  it('is stable, distinct per key, and never contains the key material', () => {
    expect(keyFingerprint('sk-x-123')).toBe(keyFingerprint('sk-x-123'));
    expect(keyFingerprint('sk-x-123')).not.toBe(keyFingerprint('sk-x-124'));
    expect(keyFingerprint('sk-x-123')).toMatch(/^key_[0-9a-f]{12}$/);
    expect(keyFingerprint('sk-x-123')).not.toContain('sk-x-123');
  });
});
