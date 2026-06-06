import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // import.meta.url shim for the cjs build (migrations dir resolution in migrate.ts).
  shims: true,
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  external: ['pg', 'drizzle-orm'],
});
