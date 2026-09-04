import { defineConfig } from 'tsdown';

const buildVersion = process.env.BT_WORKER_BUILD_VERSION;
const buildSha = process.env.BT_WORKER_BUILD_SHA;

if (!buildVersion) {
  throw new Error(
    'worker build metadata is missing; run `bun run build` instead of invoking tsdown directly',
  );
}

export default defineConfig({
  entry: ['src/index.ts', 'src/embedded.ts', 'src/main.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  // scripts/write-build-info.mjs resolves these once, then passes them to the
  // bundler without ever rewriting tracked source. An empty SHA means the
  // explicit version-only fallback used outside a Git checkout.
  define: {
    __BETTER_TRIGGER_BUILD_VERSION__: JSON.stringify(buildVersion),
    __BETTER_TRIGGER_BUILD_SHA__: buildSha ? JSON.stringify(buildSha) : 'undefined',
  },
  // Matches engines.node in package.json (">=18"): the whole monorepo builds to
  // the Node 18 floor and the runtime never reaches for a Node 20-only API.
  target: 'node18',
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  // `better-trigger` MUST stay external: the worker and the user's task modules
  // have to share ONE copy of its AsyncLocalStorage, or ctx-aware calls
  // (triggerAndWait / durable trigger) inside a run would not see the executor.
  deps: {
    neverBundle: ['pg', 'hono', '@hono/node-server', 'better-trigger'],
  },
  // Only the CLI bin (dist/main.js) is executed directly and needs a shebang;
  // the library (index) and embedded bundles are imported, never run as a
  // script, so a shebang on them is noise.
  banner: ({ fileName }) => (fileName === 'main.js' ? '#!/usr/bin/env node' : undefined),
});
