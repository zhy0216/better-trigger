/* =============================================================================
   better-trigger — betterTrigger() env-var defaults (01-core-sdk T11).

   The factory resolves url / apiKey from BETTER_TRIGGER_URL /
   BETTER_TRIGGER_API_KEY when the caller omits them (instance.ts env()), so an
   app configured purely by environment does not have to thread the daemon URL
   and token through every call site. An explicit option must win over the env.
   ============================================================================= */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { betterTrigger } from '../src/instance';

function stubFetch(res: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: any, init: any) => {
    calls.push({ url: String(input), init: init ?? {} });
    return res;
  };
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe('betterTrigger() — environment defaults', () => {
  const savedUrl = process.env.BETTER_TRIGGER_URL;
  const savedKey = process.env.BETTER_TRIGGER_API_KEY;

  beforeEach(() => {
    process.env.BETTER_TRIGGER_URL = 'http://env-daemon.test:4949';
    process.env.BETTER_TRIGGER_API_KEY = 'env-secret';
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.BETTER_TRIGGER_URL;
    else process.env.BETTER_TRIGGER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
    else process.env.BETTER_TRIGGER_API_KEY = savedKey;
  });

  it('defaults url and apiKey from the environment', async () => {
    const { fetch, calls } = stubFetch(
      new Response('{"ok":true,"version":"9.9.9"}', { status: 200 }),
    );
    const trigger = betterTrigger({ fetch });

    expect(trigger.url).toBe('http://env-daemon.test:4949');
    await trigger.health();
    expect(calls[0]!.url).toBe('http://env-daemon.test:4949/api/v1/health');
    // The env-derived apiKey rides as a bearer token on every request.
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer env-secret' });
  });

  it('explicit options win over the environment', () => {
    const { fetch } = stubFetch(new Response('{}', { status: 200 }));
    const trigger = betterTrigger({ url: 'http://explicit.test', fetch });
    expect(trigger.url).toBe('http://explicit.test');
  });

  it('falls back to the localhost default when neither env nor option is set', () => {
    delete process.env.BETTER_TRIGGER_URL;
    const { fetch } = stubFetch(new Response('{}', { status: 200 }));
    const trigger = betterTrigger({ fetch });
    expect(trigger.url).toBe('http://localhost:4848');
  });
});
