/* =============================================================================
   @better-trigger/worker — same-origin dashboard hosting (O3).

   The daemon owns the built dashboard: `apps/web`'s dist is embedded into the
   worker package at build time (dist/public, see scripts/copy-public.mjs) and
   served from the same port as the API, so a deployment needs exactly one
   port, no CORS and no extra origin to allow.

   Routing contract (unchanged API surface):
     - /api/v1/*            → API only. Anything that decodes to /api or
                              /api/* — including encoded separators such as
                              /api%2fv1/nope or double-encoded /api%252Fv1/nope
                              — is skipped here and keeps answering the JSON
                              404 the app's notFound handler writes.
     - / and /index.html    → the dashboard shell (index.html, no-cache).
     - /assets/<hashed>     → static files. Vite names everything under
                              assets/ with a content hash, so these are
                              `immutable` for a year — a redeploy ships new
                              hashes and the old URLs are never re-fetched.
     - /runs/…, /schedules… → SPA deep links: an extension-less path that is
                              NOT a real file falls back to index.html
                              (no-cache), so a refresh of a deep link never
                              404s. An extension-less path that IS a file
                              (COPYING, LICENSE) is served as itself.
     - everything else      → unchanged JSON 404 (no dist built / no such
                              file / the path escapes public).

   Cache strategy: the shell (index.html, however it was reached) is always
   served `no-cache` (revalidate on every load), so after a daemon restart the
   browser re-fetches it and follows the NEW hashed asset URLs — the
   content-hash names make the old bundles unreachable instead of stale.
   Assets are keyed by size+mtime ETags, and `If-None-Match` answers 304
   without re-reading the file.

   `publicDir` is resolved once at factory time: a build without the dashboard
   (no dist/public, e.g. a source checkout that has not run the web build)
   behaves exactly as before — JSON 404 on non-API paths.

   Security: paths are URL-decoded (twice, so double-encoded segments cannot
   smuggle a `..` or a backslash past the checks), rejected when they contain
   `..` segments or resolve outside public, and every served file is
   realpath-checked so a symlink inside public cannot point at a file outside
   it.
   ============================================================================= */
import { realpathSync, statSync } from 'node:fs';
import { realpath, stat, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/** Vite's default assetsDir: everything under here carries a content hash. */
const ASSETS_PREFIX = '/assets/';
/** Hashed assets never change; the browser may cache them forever. */
const ASSETS_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Un-hashed static files (favicons, …) change with a redeploy: 1h. */
const FILES_CACHE_CONTROL = 'public, max-age=3600';
/** The shell must be revalidated every load so a redeploy is picked up. */
const HTML_CACHE_CONTROL = 'no-cache';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/** The last path segment ends in `.<extension>` — a file name, not a SPA route. */
function hasExtension(path: string): boolean {
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  return /\.\w+$/.test(base);
}

/**
 * URL-decode a request path, twice: a double-encoded segment (%252e) must not
 * smuggle a `..` past the checks below. Malformed escapes are left as-is —
 * the literal filename cannot exist, so they resolve to a 404 or the SPA
 * fallback, never to a file outside public.
 */
function decodePath(raw: string): string {
  let p = raw;
  for (let i = 0; i < 2 && p.includes('%'); i++) {
    try {
      const next = decodeURIComponent(p);
      if (next === p) break;
      p = next;
    } catch {
      break;
    }
  }
  return p;
}

/**
 * Everything under /api/ is the API's territory. Judged on the DECODED path:
 * the raw pathname keeps percent-encoding, so /api%2fv1/nope (or its
 * double-encoded form) would otherwise slip past the check into the SPA
 * fallback and answer 200 where the API answers 404.
 */
function isApiPath(decoded: string): boolean {
  return decoded === '/api' || decoded.startsWith('/api/');
}

/**
 * Resolve `pathname` (already URL-decoded) inside `root`, or null when the
 * request would escape it. `..` segments and backslashes are rejected
 * outright — no amount of alias/encoding cleverness should let a request read
 * outside the dashboard.
 */
function resolveInside(root: string, decodedPath: string): string | null {
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) return null;
  const segments = decodedPath.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  const resolved = join(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

const NOT_FOUND_BODY = JSON.stringify({
  error: { code: 'not_found', message: 'route not found' },
});

function notFound(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Serve `target` (already lexically inside root) with the right content-type,
 * cache headers and ETag — or null when it is missing, not a file, or a
 * symlink whose real path lands outside the public root.
 */
async function serveFile(
  realRoot: string,
  target: string,
  requestPath: string,
  method: string,
  ifNoneMatch: string | undefined,
): Promise<Response | null> {
  let st;
  try {
    st = await stat(target);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  // A symlink inside public must not escape it: resolve the REAL path and
  // re-check containment (the lexical resolveInside above cannot see links).
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;

  // size+mtime ETag; a matching If-None-Match answers 304 without reading the
  // body. (Weak is fine — this is a cache validator, not content proof.)
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  // Keyed on the file actually served, not the request path: the SPA
  // fallback and /index.html both deliver the shell, and the shell must be
  // revalidated every load so a redeploy is picked up.
  const isShell = target.endsWith('/index.html');
  const cacheControl = isShell
    ? HTML_CACHE_CONTROL
    : requestPath.startsWith(ASSETS_PREFIX)
      ? ASSETS_CACHE_CONTROL
      : FILES_CACHE_CONTROL;
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(target),
    ETag: etag,
    'Cache-Control': cacheControl,
    'Content-Length': String(st.size),
  };
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers });
  }

  const body = await readFile(target);
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}

/**
 * Middleware serving the embedded dashboard. `publicDir` is the directory
 * containing the built web app (index.html + assets/). When it is absent or
 * not a directory, requests pass through untouched: non-API paths keep the
 * JSON 404 the app's notFound handler writes (pre-O3 behavior).
 */
export function dashboardStatic(publicDir: string | undefined): MiddlewareHandler {
  let root: string | null = null;
  let realRoot: string | null = null;
  if (publicDir !== undefined) {
    try {
      if (statSync(publicDir).isDirectory()) {
        root = publicDir;
        realRoot = realpathSync(publicDir);
      }
    } catch {
      /* not present: no dashboard embedded, keep the old 404 behavior */
    }
  }
  return async (c, next) => {
    if (root === null || realRoot === null) return next();
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();

    // The API owns everything that decodes to /api — encoded separators
    // (/api%2f…) included. Everything else may be dashboard territory.
    const decoded = decodePath(c.req.path);
    if (isApiPath(decoded)) return next();

    const requestPath = c.req.path;
    const ifNoneMatch = c.req.header('If-None-Match');

    if (hasExtension(decoded)) {
      // A real file reference: serve it, or 404 — never the SPA shell, or a
      // missing /assets/foo.js would answer HTML under a JS content-type.
      const target = resolveInside(root, decoded);
      if (target === null) return notFound();
      return (await serveFile(realRoot, target, requestPath, method, ifNoneMatch)) ?? notFound();
    }

    // No extension: serve the request path itself when it is a real file
    // (COPYING, LICENSE, …), otherwise the SPA shell for the deep link.
    const target = resolveInside(root, decoded);
    const direct =
      target === null ? null : await serveFile(realRoot, target, requestPath, method, ifNoneMatch);
    if (direct !== null) return direct;
    return (
      (await serveFile(realRoot, join(root, 'index.html'), requestPath, method, ifNoneMatch)) ??
      notFound()
    );
  };
}
