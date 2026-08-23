import { defineConfig } from 'tsdown';

export default defineConfig({
  // ./internal is a separate entry (never bundled into ./index) so the worker
  // daemon and the user's task modules share ONE instance of the module — and
  // therefore one AsyncLocalStorage. See src/internal.ts.
  entry: ['src/index.ts', 'src/internal.ts'],
  deps: {
    neverBundle: ['node:async_hooks'],
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  // The SDK is intentionally importable in edge/browser runtimes. Neutral
  // keeps the ESM `require` fallback guarded instead of injecting Node's
  // `createRequire`; CJS remains a normal Node build.
  platform: 'neutral',
  target: 'node18',
});
