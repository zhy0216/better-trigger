/* =============================================================================
   @better-trigger/web — dashboard lint config: the shared repo baseline
   (../../eslint.config.mjs) plus the React rules this app needs. The shared
   config supplies eslint:recommended + typescript-eslint recommended and the
   node globals; this file adds browser globals and the React hooks/refresh
   plugins.
   ============================================================================= */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { sharedIgnores, sharedTsConfig } from '../../eslint.config.mjs';

export default tseslint.config(
  sharedIgnores,
  sharedTsConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      // Merged over the shared config's node globals: browser wins on the
      // names both define (window, document, fetch...), node-only names
      // (process) are harmless leftovers the dashboard never touches.
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
);
