import { defineConfig } from 'tsup';

export default defineConfig({
  // ./internal is a separate entry (never bundled into ./index) so the worker
  // daemon and the user's task modules share ONE instance of the module — and
  // therefore one AsyncLocalStorage. See src/internal.ts.
  entry: ['src/index.ts', 'src/internal.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
});
