import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  target: 'node18',
  // import.meta.url shim for the cjs build (migrations dir resolution in migrate.ts).
  shims: true,
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  deps: { neverBundle: ['pg', 'drizzle-orm'] },
});
