import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  external: ['pg', 'drizzle-orm', 'hono', '@hono/node-server', 'croner'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
