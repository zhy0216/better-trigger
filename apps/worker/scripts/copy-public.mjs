#!/usr/bin/env node
/* =============================================================================
   @better-trigger/worker — embed the built dashboard into dist/public (O3).

   Runs AFTER tsdown (tsdown's `clean: true` wipes dist/, so the copy must be the
   last step of the build). Builds apps/web first, then copies its dist into
   apps/worker/dist/public — the directory the daemon serves on / and the SPA
   fallback. dist/public travels with the published package ("files": ["dist"])
   and with the Docker image (COPY apps/worker/dist), so the daemon serves the
   dashboard same-origin wherever it runs, with no extra port or origin config.

   Fails loudly when the web build produces no index.html: an image whose
   "serve the dashboard" promise cannot be met should not be built silently.
   ============================================================================= */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(workerRoot, '..', 'web');
const webDist = join(webRoot, 'dist');
const publicDir = join(workerRoot, 'dist', 'public');

execSync('bun run build', { cwd: webRoot, stdio: 'inherit' });

if (!existsSync(join(webDist, 'index.html'))) {
  throw new Error(
    `[worker] dashboard build produced no index.html at ${webDist} — cannot embed`,
  );
}

rmSync(publicDir, { recursive: true, force: true });
cpSync(webDist, publicDir, { recursive: true });
console.log(`[worker] dashboard embedded: ${webDist} -> ${publicDir}`);
