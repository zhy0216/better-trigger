import { defineConfig } from 'tsdown';
import { sourcePackageExternals } from '../../scripts/source-package-externals.mjs';

export default defineConfig({
  plugins: [sourcePackageExternals()],
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Keep cross-package source declarations inside the compiler's temp output.
  dts: { tsconfig: '../../tsconfig.build.json' },
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  target: 'node18',
  // Keep heavy/native deps external so they resolve from node_modules at runtime.
  deps: { neverBundle: ['pg', 'croner'] },
});
