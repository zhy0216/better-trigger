/* =============================================================================
   better-trigger — shared ESLint flat config (O5, todos/03-operability.md).

   One baseline for every JavaScript/configuration file in the repo. TypeScript
   is validated by `tsc`; keeping ESLint JavaScript-only avoids coupling the
   compiler upgrade to a separate TypeScript parser/plugin release. `apps/web`
   has its own config (React rules) and imports the shared pieces from here;
   every other package picks this file up automatically — ESLint walks up from
   the linted directory to the nearest config, which for the packages under
   apps/, packages/ and examples/ is this file at the repo root.

   The baseline uses ESLint's recommended JavaScript rules with Node globals
   for the daemon/library packages. The rules are deliberately the shared
   baseline only: style churn is not the point of O5, coverage is. Real
   violations stay on; stylistic preferences that the codebase does not
   follow are tuned off here (or in a package's own config) rather than
   forcing a mass reformat.
   ============================================================================= */
import js from '@eslint/js';
import globals from 'globals';

/** Build/runtime output that must never be linted. */
export const sharedIgnores = {
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/public/**',
    '**/*.{ts,tsx}',
  ],
};

/** The common JavaScript ruleset used by every workspace. */
export const sharedJsConfig = {
  ...js.configs.recommended,
  files: ['**/*.{js,jsx,mjs,cjs}'],
  languageOptions: {
    ...js.configs.recommended.languageOptions,
    ecmaVersion: 2020,
    // The daemon / kernel / SDK / harness packages run on Node. apps/web
    // merges browser globals over this in its own config.
    globals: globals.node,
  },
  rules: {
    // The repo's convention for an intentionally unused parameter is an
    // underscore prefix (`_payload`, `_ctx` in test fixtures) — honor it
    // instead of forcing renames.
    'no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Best-effort cleanup in tests is `try { ... } catch {}` on purpose.
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
};

export default [sharedIgnores, sharedJsConfig];
