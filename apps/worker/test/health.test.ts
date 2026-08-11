/* =============================================================================
   @better-trigger/worker — health probe tests (O5).

   /health used to answer `{ ok: true }` without touching Postgres, so
   "HTTP process alive, database gone" — the one failure a probe exists to
   catch — read as healthy. The shallow answer stays as the liveness probe;
   ?deep=1 is the readiness one: SELECT 1 under a deadline, pool counters, 503
   when the DB does not answer.

   Both live on /api/v1/health because that exact path is what middleware.ts
   opens to unauthenticated callers, so the 503 must stay a 503 there too.
   Driven through createApp with stub deps: no Postgres involved.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
// O4: the injected build metadata (package version + git sha) is the single
// version source — the tests assert against it, never a hardcoded literal, so
// a version bump can never leave /health behind.
import { BUILD_SHA, BUILD_VERSION } from '../src/generated/build-info';

const kernel = {} as unknown as Kernel;

/**
 * An app whose pool answers `query` with `impl`, and carries pg's counters.
 * The deep probe checks out a client explicitly (pool.connect() + release),
 * so the stub's connect() hands back a client whose query is `impl` and whose
 * release is recorded in `releases` — that is what makes the connection-return
 * contract assertable without a real Postgres.
 */
const makeApp = (
  impl: () => Promise<unknown>,
  counts?: Partial<Record<string, number>>,
  releases?: boolean[],
) => {
  const pool = {
    connect: async () => ({ query: impl, release: () => releases?.push(true) }),
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0,
    ...counts,
  } as unknown as Pool;
  return createApp({ kernel, pool });
};

const healthy = () => makeApp(async () => ({ rows: [{ '?column?': 1 }] }));

/** A realistic pg failure: it names the host it could not reach. */
const dbDown = () =>
  makeApp(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.4:5432');
  });

const get = (path: string) => new Request(`http://localhost:4848${path}`);

/**
 * An app with the two pools a PF4 daemon owns: the business `pool` (whose
 * `query` must never see a probe) and the dedicated `probePool` (whose
 * connect()/client is what /health?deep=1 exercises). Pass only the business
 * pool and the probe falls back to it, exactly like an embedded
 * createApp({ kernel, pool }).
 */
const makeProbeApp = (
  businessQuery: () => Promise<unknown>,
  probeClientQuery: () => Promise<unknown>,
  counts?: Partial<Record<string, number>>,
  probeReleases?: boolean[],
) =>
  createApp({
    kernel,
    pool: { query: businessQuery, totalCount: 3, idleCount: 2, waitingCount: 0, ...counts } as unknown as Pool,
    probePool: {
      connect: async () => ({ query: probeClientQuery, release: () => probeReleases?.push(true) }),
    } as unknown as Pool,
  });

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

describe('shallow /health (liveness)', () => {
  it('answers 200 without touching the database', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const res = await makeApp(query).fetch(get('/api/v1/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: BUILD_VERSION, sha: BUILD_SHA });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports the injected build metadata, not a hardcoded literal', async () => {
    const res = await healthy().fetch(get('/api/v1/health'));
    const body = (await res.json()) as { version: string; sha?: string };
    // The semver is the package version — the value the published tarball
    // carries — so /health.version is traceable to the release, and `sha` to
    // the commit it was built from (absent outside a git checkout).
    expect(body.version).toBe(BUILD_VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (BUILD_SHA !== undefined) {
      expect(body.sha).toBe(BUILD_SHA);
      // git short sha, optionally with the -dirty marker of an uncommitted tree.
      expect(body.sha).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
    }
  });

  it('stays 200 while the database is down', async () => {
    // The whole point of keeping it: a liveness probe answering 503 gets the
    // container killed and restarted over a failure a restart cannot fix.
    const res = await dbDown().fetch(get('/api/v1/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: BUILD_VERSION, sha: BUILD_SHA });
  });
});

describe('deep /health?deep=1 (readiness)', () => {
  it('runs SELECT 1 and reports the pool counters', async () => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    const app = makeApp(query, { totalCount: 5, idleCount: 1, waitingCount: 2 });
    const res = await app.fetch(get('/api/v1/health?deep=1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: BUILD_VERSION,
      sha: BUILD_SHA,
      db: { ok: true },
      pool: { total: 5, idle: 1, waiting: 2 },
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('accepts deep=true as well', async () => {
    const res = await healthy().fetch(get('/api/v1/health?deep=true'));
    expect(res.status).toBe(200);
    expect((await res.json()) as { db: unknown }).toMatchObject({ db: { ok: true } });
  });

  it('answers 503 when the query throws', async () => {
    const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      version: BUILD_VERSION,
      sha: BUILD_SHA,
      db: { ok: false, error: 'query_failed' },
      pool: { total: 3, idle: 2, waiting: 0 },
    });
  });

  it('leaks neither the host nor the pg message', async () => {
    // The endpoint is unauthenticated by design, so its body is public.
    const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
    const wire = JSON.stringify(await res.json());
    expect(wire).not.toContain('10.0.0.4');
    expect(wire).not.toContain('ECONNREFUSED');
  });

  it('counts a hung query as unhealthy instead of hanging with it', async () => {
    vi.useFakeTimers();
    try {
      // A dead peer or a saturated pool leaves the query pending forever.
      const app = makeApp(() => new Promise(() => {}));
      const pending = app.fetch(get('/api/v1/health?deep=1'));
      await vi.advanceTimersByTimeAsync(2000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect((await res.json()) as { db: unknown }).toMatchObject({
        ok: false,
        db: { ok: false, error: 'timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // There is deliberately no test for "the hung query rejects after the
  // deadline takes the daemon down". That cannot happen and so cannot regress:
  // `Promise.race` subscribes to *every* input, so the loser's late rejection
  // is already observed by the race itself — it never reaches
  // process.on('unhandledRejection'), whatever probeDb does with the winner.
  // A test asserting that handler stays silent is green against any
  // implementation, i.e. it is not a test.

  it('disarms the deadline once the query answers', async () => {
    // The deadline is a live setTimeout, and a pending timer holds the event
    // loop open: forget the clearTimeout and every cheap probe pins the process
    // for the full 2s, so a SIGTERM arriving just after a healthcheck waits on
    // a timer nobody needs any more.
    vi.useFakeTimers();
    try {
      const res = await healthy().fetch(get('/api/v1/health?deep=1'));
      expect(res.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the deadline once the query fails', async () => {
    vi.useFakeTimers();
    try {
      const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
      expect(res.status).toBe(503);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deep /health?deep=1 — dedicated probe pool (PF4)', () => {
  it('probes through the probe pool, never the business pool', async () => {
    // The whole point of the separate pool: the probe's SELECT 1 must not
    // borrow a connection the business queries need (a probe storm then cannot
    // deplete the business pool). The pool stats still describe the business
    // pool — that is the pool whose saturation a readiness check should see.
    const businessQuery = vi.fn(async () => {
      throw new Error('business query should not run');
    });
    const probeQuery = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    const releases: boolean[] = [];
    const app = makeProbeApp(businessQuery, probeQuery, undefined, releases);

    const res = await app.fetch(get('/api/v1/health?deep=1'));

    expect(res.status).toBe(200);
    expect((await res.json()) as { db: unknown; pool: unknown }).toMatchObject({
      db: { ok: true },
      pool: { total: 3, idle: 2, waiting: 0 },
    });
    expect(probeQuery).toHaveBeenCalledWith('SELECT 1');
    expect(businessQuery).not.toHaveBeenCalled();
    // The checked-out client came back to the probe pool.
    expect(releases).toEqual([true]);
  });

  it('answers 503 at the deadline when the probe hangs, leaving the business pool untouched', async () => {
    // 验收: a probe that never returns must (a) answer the HTTP request within
    // the deadline and (b) never hold a business connection. The real
    // cancellation of the hung query is the probe pool's statement_timeout —
    // covered at the pool level (packages/db pool.test.ts) and against a real
    // Postgres (examples/basic scripts/health-pool.ts) — so this pins the
    // route side: the deadline fires, the checked-out client is released, and
    // the business pool saw nothing.
    vi.useFakeTimers();
    try {
      const businessQuery = vi.fn(async () => {
        throw new Error('business query should not run');
      });
      const releases: boolean[] = [];
      const app = makeProbeApp(businessQuery, () => new Promise(() => {}), undefined, releases);
      const pending = app.fetch(get('/api/v1/health?deep=1'));
      await vi.advanceTimersByTimeAsync(2000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect((await res.json()) as { db: unknown }).toMatchObject({
        ok: false,
        db: { ok: false, error: 'timeout' },
      });
      // The hung query outlived the deadline, yet the connection came back:
      // the probe's finally released the checked-out client exactly once (pg
      // discards a client released with an in-flight query, so the probe pool
      // keeps its full capacity for the next probe).
      expect(releases).toEqual([true]);
      expect(businessQuery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the checked-out client exactly once on success', async () => {
    const releases: boolean[] = [];
    const app = makeProbeApp(async () => ({ rows: [] }), async () => ({ rows: [{ '?column?': 1 }] }), undefined, releases);
    const res = await app.fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(200);
    // The query settled before the deadline, so the continuation released —
    // and the deadline's finally did not double-release.
    expect(releases).toEqual([true]);
  });

  it('concurrent deep probes share ONE probe query (single-flight)', async () => {
    // 并发场景: N simultaneous probes must not queue N queries on the probe
    // pool — the first probe's outcome IS the answer for all of them, so the
    // pool never has more than one probe query in flight.
    let resolveGate: (() => void) | undefined;
    const probeQuery = vi.fn(
      () =>
        new Promise<{ rows: unknown[] }>((resolve) => {
          resolveGate = () => resolve({ rows: [{ '?column?': 1 }] });
        }),
    );
    const connects = vi.fn(async () => ({ query: probeQuery, release: () => {} }));
    const app = createApp({
      kernel,
      pool: { query: async () => ({ rows: [] }), totalCount: 3, idleCount: 2, waitingCount: 0 } as unknown as Pool,
      probePool: { connect: connects } as unknown as Pool,
    });

    const pending = [
      app.fetch(get('/api/v1/health?deep=1')),
      app.fetch(get('/api/v1/health?deep=1')),
      app.fetch(get('/api/v1/health?deep=1')),
      app.fetch(get('/api/v1/health?deep=1')),
    ];
    // Let the first probe start (connect + query) before checking the count.
    await new Promise((r) => setTimeout(r, 0));
    expect(connects).toHaveBeenCalledTimes(1);
    expect(probeQuery).toHaveBeenCalledTimes(1);

    resolveGate!();
    for (const p of pending) {
      const res = await p;
      expect(res.status).toBe(200);
      expect((await res.json()) as { db: unknown }).toMatchObject({ db: { ok: true } });
    }
    expect(connects).toHaveBeenCalledTimes(1);
    expect(probeQuery).toHaveBeenCalledTimes(1);
  });
});

describe('auth', () => {
  it('keeps the deep probe open: a healthcheck has no API key to send', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-local-abcdefghijklmnop';
    const res = await healthy().fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(200);
  });

  it('answers 503, not 401, when the DB is down and a key is configured', async () => {
    // Same path as the shallow probe, so the auth skip must not start
    // depending on the response — otherwise the probe reports the wrong fault.
    process.env.BETTER_TRIGGER_API_KEY = 'sk-local-abcdefghijklmnop';
    const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(503);
  });
});
