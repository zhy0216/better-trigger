/* =============================================================================
   @better-trigger/worker — /metrics is wired to the live counters (O4).

   metrics.test.ts drives createApp() with a MetricsSources it builds itself, so
   it proves the route reads whatever it is given. It cannot prove that the
   daemon gives it anything: delete `metrics: { worker, orchestrator }` from the
   createApp call in main.ts and every one of those tests still passes, while
   production's /metrics silently falls back to fresh zeroed counters — and that
   call site is the ONLY path by which a scrape sees real numbers.

   The gap needs a real process, so this spawns the CLI the way host.test.ts and
   crash.test.ts do. It also needs a counter that is provably non-zero without a
   database, which is what an unreachable DATABASE_URL provides: the reaper loop
   fails on every tick, so `orchestrator_errors_total{loop="reaper"}` climbs on
   its own. A daemon whose metrics source is not wired reports 0 there forever.
   ============================================================================= */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** An OS-assigned port, released before the CLI is handed it. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** One sample's value, by metric name and (optional) single label. */
function sampleValue(
  body: string,
  name: string,
  label?: [string, string],
): number | undefined {
  const selector = label ? `${name}{${label[0]}="${label[1]}"}` : name;
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue;
    const sep = line.lastIndexOf(' ');
    if (sep === -1) continue;
    if (line.slice(0, sep) === selector) return Number(line.slice(sep + 1));
  }
  return undefined;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/**
 * Boots a daemon whose database is not there and returns once it is listening.
 * --no-migrate is what gets it fully up without a Postgres (same trick as
 * host.test.ts); the short reap interval is what makes the loop counter move
 * inside a test's patience.
 */
async function bootDaemon(): Promise<number> {
  const port = await freePort();
  const clean = { ...process.env };
  delete clean.BETTER_TRIGGER_API_KEY; // the scrape below carries no token
  delete clean.BETTER_TRIGGER_HOST;
  const child = spawn(
    'bun',
    [MAIN, '--port', String(port), '--no-migrate', '--reaper-interval-ms', '100'],
    {
      env: { ...clean, DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);

  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`daemon never listened:\n${out}`)), 20_000);
    const collect = (d: Buffer): void => {
      out += d.toString();
      if (/listening on/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', collect);
    // stderr carries the reaper's own failures; drained so the pipe never fills.
    child.stderr!.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return port;
}

/** Scrapes until `pred` holds, so the assertions do not race the first reap. */
async function scrapeUntil(
  port: number,
  pred: (body: string) => boolean,
  timeoutMs = 15_000,
): Promise<{ status: number; contentType: string; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: string;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/metrics`);
    last = await res.text();
    if (pred(last)) {
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: last,
      };
    }
    if (Date.now() > deadline) throw new Error(`metrics never satisfied:\n${last}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the daemon serves its own counters', () => {
  it(
    'reports live orchestrator counters, not a fresh zeroed set',
    async () => {
      const port = await bootDaemon();
      const { status, contentType, body } = await scrapeUntil(
        port,
        (b) => (sampleValue(b, 'better_trigger_orchestrator_errors_total', ['loop', 'reaper']) ?? 0) > 0,
      );

      expect(status).toBe(200);
      expect(contentType).toContain('text/plain');
      expect(contentType).toContain('version=0.0.4');

      // The assertion this file exists for: a number that can only have come
      // from the orchestrator this process actually started.
      expect(
        sampleValue(body, 'better_trigger_orchestrator_errors_total', ['loop', 'reaper']),
      ).toBeGreaterThan(0);
      // The loops this API-only daemon does not run stay at zero, so the
      // reading above is the reaper's and not a blanket "everything counts".
      expect(
        sampleValue(body, 'better_trigger_orchestrator_errors_total', ['loop', 'waits']),
      ).toBe(0);
      expect(
        sampleValue(body, 'better_trigger_orchestrator_errors_total', ['loop', 'cron']),
      ).toBe(0);
    },
    40_000,
  );

  it(
    'says the database is down and still exports every in-process family',
    async () => {
      const port = await bootDaemon();
      const { body } = await scrapeUntil(port, (b) =>
        b.includes('better_trigger_db_up'),
      );

      // The scrape succeeds while Postgres does not: db_up says which.
      expect(sampleValue(body, 'better_trigger_db_up')).toBe(0);
      // ...and the gauges that need it are omitted rather than reported as 0 —
      // "queue depth 0" and "queue depth unknown" must not look alike.
      expect(sampleValue(body, 'better_trigger_queue_depth', ['state', 'available'])).toBeUndefined();
      expect(sampleValue(body, 'better_trigger_inflight_runs')).toBeUndefined();

      // The in-process families survive a dead database — they are exactly what
      // says how long it has been dead.
      expect(sampleValue(body, 'better_trigger_runs_total', ['outcome', 'completed'])).toBe(0);
      expect(
        sampleValue(body, 'better_trigger_reaper_recovered_total', ['outcome', 'requeued']),
      ).toBe(0);
      expect(sampleValue(body, 'better_trigger_claim_errors_total')).toBe(0);
      expect(sampleValue(body, 'better_trigger_worker_inflight_runs')).toBe(0);
    },
    40_000,
  );
});
