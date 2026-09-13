import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = new Map([
  ['packages/core/src/index', '@better-trigger/core'],
  ['packages/db/src/index', '@better-trigger/db'],
  ['packages/kernel/src/index', '@better-trigger/kernel'],
  ['packages/sdk/src/index', 'better-trigger'],
  ['packages/sdk/src/internal', 'better-trigger/internal'],
].map(([file, name]) => [resolve(root, file), name]));

/**
 * Source consumers use relative imports so a Git checkout needs no workspace
 * links or build. Published packages keep their npm dependency boundaries,
 * especially the SDK registry shared by task definitions and the worker.
 */
export function sourcePackageExternals() {
  return {
    name: 'source-package-externals',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return;
      const entry = resolve(dirname(importer), source).replace(/(?:\.d)?\.[cm]?ts$/, '');
      const name = entries.get(entry);
      if (name) return { id: name, external: true };
    },
  };
}
