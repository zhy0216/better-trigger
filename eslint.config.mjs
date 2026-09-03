/* =============================================================================
   better-trigger — shared ESLint flat config (O5, todos/03-operability.md;
   P2-20 extended it to TypeScript).

   One baseline for every source and configuration file in the repo.
   JavaScript gets ESLint's recommended rules (`sharedJsConfig`); TypeScript
   gets the SAME rule surface through `sharedTsConfig` — the
   typescript-eslint parser only, no typed rules. `tsc` remains the type
   checker; ESLint on .ts/.tsx exists so the shared baseline (and, in
   apps/web, the react-hooks rules) actually sees application code instead of
   only the handful of JS config files. `apps/web` has its own config (React
   rules) and imports the shared pieces from here; every other package picks
   this file up automatically — ESLint walks up from the linted directory to
   the nearest config, which for the packages under apps/, packages/ and
   examples/ is this file at the repo root.

   Why the root `typescript` devDependency is pinned to ^6 while every
   workspace builds with ^7: typescript-eslint@8 consumes the classic JS
   compiler API that TS 7.0 removed, and it resolves `typescript` through its
   peer — i.e. from this root package. The workspaces keep their own
   typescript@^7 for `tsc`/`typecheck`, so the two coexist side by side (the
   layout the TS 7 release notes recommend). Nothing else in the repo
   resolves `typescript` from the root.

   The TypeScript rule set is deliberately the two-rule minimum:
   `no-unused-vars` becomes the parser-aware @typescript-eslint variant (the
   base rule misreports type positions), and `no-undef` is off because tsc
   already answers it for typed code and the base rule misreads type
   references. Everything else from `eslint:recommended` applies as-is. Real
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

/** The common JavaScript ruleset used by every workspace. */
export const sharedJsConfig = {
  ...js.configs.recommended,
  files: ['**/*.{js,jsx,mjs,cjs}'],
  languageOptions: {
    ...js.configs.recommended.languageOptions,
    // ES2022 for the top-level await in apps/docs/validate-mermaid.mjs; the
    // old 2020 ceiling rejected the file outright.
    ecmaVersion: 2022,
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

/**
 * The TypeScript counterpart of `sharedJsConfig`: same recommended rules,
 * parsed by typescript-eslint so .ts/.tsx/.mts is actually linted. Parser-only —
 * no `project`/type-aware rules, so ESLint never doubles as a second type
 * checker and no program graph is rebuilt per run.
 */
export const sharedTsConfig = {
  files: ['**/*.{ts,tsx,mts}'],
  languageOptions: {
    parser: tseslint.parser,
    // Same default as the JS baseline: Node globals for every package;
    // apps/web merges browser globals over this in its own config.
    globals: globals.node,
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin,
  },
  rules: {
    ...js.configs.recommended.rules,
    // tsc answers `no-undef` for typed code (and the base rule has no idea
    // about type-only references, generics in scope, or `declare` blocks).
    'no-undef': 'off',
    // Same story for overload signatures and declaration merging
    // (`packages/sdk/src/task.ts`): legal TS the base rule reads as a
    // redeclaration.
    'no-redeclare': 'off',
    // The base variant misreports TS constructs (parameter properties,
    // type-only usage); the parser-aware rule is the same check, done right.
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
};

export default [sharedIgnores, sharedJsConfig, sharedTsConfig];
