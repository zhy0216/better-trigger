import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/embedded.ts', 'src/main.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  // `better-trigger` MUST stay external: the worker and the user's task modules
  // have to share ONE copy of its AsyncLocalStorage, or ctx-aware calls
  // (triggerAndWait / durable trigger) inside a run would not see the executor.
  external: ['pg', 'hono', '@hono/node-server', 'better-trigger'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
