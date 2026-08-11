/* =============================================================================
   better-trigger — shared ESLint flat config (O5, todos/03-operability.md).

   One baseline for every TypeScript package in the repo. `apps/web` has its
   own config (React rules) and imports the shared pieces from here; every
   other package picks this file up automatically — ESLint walks up from the
   linted directory to the nearest config, which for the packages under
   apps/, packages/ and examples/ is this file at the repo root.

   The baseline mirrors what apps/web already ran (ESLint 9 flat config,
   eslint:recommended + typescript-eslint recommended), with Node globals for
   the daemon/library packages. The rules are deliberately the shared
   baseline only: style churn is not the point of O5, coverage is. Real
   violations stay on; stylistic preferences that the codebase does not
   follow are tuned off here (or in a package's own config) rather than
   forcing a mass reformat.
   ============================================================================= */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Build/runtime output that must never be linted. */
export const sharedIgnores = {
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/public/**',
  ],
};

/** The common ruleset: eslint:recommended + typescript-eslint recommended. */
export const sharedTsConfig = {
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    ecmaVersion: 2020,
    // The daemon / kernel / SDK / harness packages run on Node. apps/web
    // merges browser globals over this in its own config.
    globals: globals.node,
  },
  rules: {
    // The codebase deliberately uses `any` in a few contract-boundary spots
    // (existing web config already had this off).
    '@typescript-eslint/no-explicit-any': 'off',
    // The repo's convention for an intentionally unused parameter is an
    // underscore prefix (`_payload`, `_ctx` in test fixtures) — honor it
    // instead of forcing renames.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Best-effort cleanup in tests is `try { ... } catch {}` on purpose.
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
};

export default tseslint.config(sharedIgnores, sharedTsConfig);
