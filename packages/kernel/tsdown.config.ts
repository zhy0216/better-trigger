import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  target: 'node18',
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  deps: { neverBundle: ['pg', 'croner'] },
});
