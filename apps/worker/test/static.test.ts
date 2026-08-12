/* =============================================================================
   @better-trigger/worker — same-origin dashboard hosting tests (O3).

   createApp with a publicDir serves the embedded dashboard on everything
   outside /api/: index.html on / and SPA deep links, extension-less files as
   themselves, hashed files under /assets/ (immutable 1y + ETag/304), JSON 404
   on missing files — and with no publicDir (a build without the dashboard)
   the pre-O3 JSON 404 stays. Security is exercised twice: through app.fetch
   (URL-normalized) and through a REAL http server with raw request paths
   (node's http client does not normalize the request line), so double-encoded
   traversal and encoded API separators cannot hide behind URL semantics.
   ============================================================================= */
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import type { ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { startHttpServer } from '../src/listen';

const kernel = {} as Kernel;
const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'public');

const withDashboard = () => createApp({ kernel, pool, publicDir });
const withoutDashboard = () => createApp({ kernel, pool });

const get = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request('http://localhost' + path, { headers }));

const expect404 = (res: Response) => {
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/json');
};

/** Every dashboard response — 200 and 304 — carries the hardening headers. */
const expectSecurityHeaders = (res: Response) => {
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
};

/** A real http server + raw-path client: no URL normalization anywhere. */
describe('raw-path security (real http server)', () => {
  let server: ServerType;
  let port: number;

  beforeAll(async () => {
    server = startHttpServer(withDashboard(), { port: 0, host: '127.0.0.1' }, (info) => {
      port = info.port;
    });
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function raw(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('encoded API separators still answer the API 404, never the SPA shell', async () => {
    for (const path of ['/api%2fv1/nope', '/api%252Fv1/nope', '/api%2fv1', '/api%2f']) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        error: { code: 'not_found', message: 'route not found' },
      });
    }
  });

  it('double-encoded and mixed traversal cannot read outside public', async () => {
    const attempts = [
      '/assets/%252e%252e/%252e%252e/package.json',
      '/%252e%252e/%252e%252e/package.json',
      '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
      '/assets/%5c..%5cpackage.json',
      '/api%2f..%2f..%2fpackage.json',
      '/assets/%2e%2e%252f%2e%2e%252fpackage.json',
    ];
    for (const path of attempts) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('serves a real asset through the raw path', async () => {
    const res = await raw('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.body).toContain('fixture dashboard bundle');
  });
});

describe('dashboard hosting with a built dashboard', () => {
  it('serves the dashboard shell on /', async () => {
    const res = await get(withDashboard(), '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expectSecurityHeaders(res);
    expect(await res.text()).toContain('dashboard fixture');
  });

  it('serves /index.html like /', async () => {
    const res = await get(withDashboard(), '/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dashboard fixture');
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await withDashboard().fetch(new Request('http://localhost/', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe('');
  });

  it('serves an extension-less file as itself instead of the SPA shell', async () => {
    const res = await get(withDashboard(), '/COPYING');
    expect(res.status).toBe(200);
    // No extension to map: octet-stream is the honest default — the point is
    // that the FILE is served, not that the SPA shell answers for it.
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toContain('extension-less file served as itself');
  });

  it('falls back to index.html for SPA deep links (refresh never 404s)', async () => {
    for (const path of [
      '/runs/run_01JX9XK9XK9XK9XK9XK9XK9XK',
      '/schedules',
      '/tasks',
      '/deployments',
    ]) {
      const res = await get(withDashboard(), path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('serves hashed assets with the immutable cache header and correct type', async () => {
    const res = await get(withDashboard(), '/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expectSecurityHeaders(res);
    expect(await res.text()).toContain('fixture dashboard bundle');
  });

  it('maps the content types in the MIME table', async () => {
    const cases: Array<[string, string]> = [
      ['/assets/app-abc123.css', 'text/css; charset=utf-8'],
      ['/assets/logo.svg', 'image/svg+xml'],
      ['/assets/logo.png', 'image/png'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/assets/app-abc123.js.map', 'application/json; charset=utf-8'],
    ];
    for (const [path, expected] of cases) {
      const res = await get(withDashboard(), path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe(expected);
    }
  });

  it('answers 304 on a matching If-None-Match without a body', async () => {
    const first = await get(withDashboard(), '/assets/app-abc123.js');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const res = await get(withDashboard(), '/assets/app-abc123.js', { 'If-None-Match': etag! });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    // The 304 reuses the same headers object as the 200: hardening applies.
    expectSecurityHeaders(res);
  });

  it('keeps /api/v1/* pure API — health still answers', async () => {
    const res = await get(withDashboard(), '/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('404s unknown API paths as JSON, never the SPA shell', async () => {
    expect404(await get(withDashboard(), '/api/v1/nope'));
    expect404(await get(withDashboard(), '/api'));
    // The encoded separator must not redirect the request into the SPA.
    expect404(await get(withDashboard(), '/api%2fv1/nope'));
    expect404(await get(withDashboard(), '/api%252Fv1/nope'));
  });

  it('404s a missing file WITH an extension instead of the SPA fallback', async () => {
    expect404(await get(withDashboard(), '/assets/missing.js'));
    expect404(await get(withDashboard(), '/favicon.ico'));
  });

  it('refuses path traversal attempts', async () => {
    expect404(await get(withDashboard(), '/assets/%2e%2e/%2e%2e/package.json'));
    expect404(await get(withDashboard(), '/%2e%2e/%2e%2e/package.json'));
    expect404(await get(withDashboard(), '/assets/..%2f..%2fpackage.json'));
    expect404(await get(withDashboard(), '/assets/%252e%252e/%252e%252e/package.json'));
  });

  it('does not serve non-GET methods (they keep the JSON 404)', async () => {
    const res = await withDashboard().fetch(
      new Request('http://localhost/', { method: 'POST', body: 'x' }),
    );
    expect404(res);
  });

  it('a symlink inside public cannot escape it, but one inside is fine', async () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges
    const outside = join(tmpdir(), `bt-outside-${randomUUID()}.txt`);
    const escape = join(publicDir, 'escape.txt');
    const inner = join(publicDir, 'inner-link.js');
    writeFileSync(outside, 'secret outside data');
    try {
      symlinkSync(outside, escape);
      symlinkSync(join(publicDir, 'assets', 'app-abc123.js'), inner);
      expect404(await get(withDashboard(), '/escape.txt'));
      // …and the realpath check must not reject links that stay inside.
      const res = await get(withDashboard(), '/inner-link.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    } finally {
      rmSync(escape, { force: true });
      rmSync(inner, { force: true });
      rmSync(outside, { force: true });
    }
  });

  it('the fixture root is not itself behind a symlink', () => {
    // The containment check compares against realpath(publicDir): a root that
    // lives behind a link (macOS /tmp → /private/tmp) would break every test.
    expect(realpathSync(publicDir)).toBe(realpathSync(publicDir));
  });
});

describe('dashboard hosting without a built dashboard', () => {
  it('keeps the pre-O3 JSON 404 on non-API paths', async () => {
    expect404(await get(withoutDashboard(), '/'));
    expect404(await get(withoutDashboard(), '/runs/run_1'));
  });
});

describe('API surface unchanged when a dashboard is attached', () => {
  it('CORS still answers loopback origins on the API', async () => {
    const res = await withDashboard().fetch(
      new Request('http://localhost/api/v1/health', {
        headers: { Origin: 'http://localhost:5173' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('auth still 401s the protected API with a JSON envelope', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'secret';
    try {
      const res = await withDashboard().fetch(new Request('http://localhost/api/v1/tasks'));
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({
        error: { code: 'unauthorized', message: 'invalid or missing API key' },
      });
    } finally {
      delete process.env.BETTER_TRIGGER_API_KEY;
    }
  });

  it('the error envelope on unknown API paths is unchanged', async () => {
    const res = await get(withDashboard(), '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'route not found' },
    });
  });
});
