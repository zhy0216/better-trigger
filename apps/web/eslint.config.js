/* =============================================================================
   @better-trigger/web — dashboard lint config: the shared repo JavaScript
   baseline (../../eslint.config.mjs) plus the React rules this app needs. The
   shared config supplies eslint:recommended and the node globals; this file
   adds browser globals and the React hooks/refresh plugins. TypeScript files
   are checked by `tsc` and are intentionally outside ESLint's parser scope.
   ============================================================================= */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { sharedIgnores, sharedJsConfig } from '../../eslint.config.mjs';

export default [
  sharedIgnores,
  sharedJsConfig,
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
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
      // react-hooks 7 enables React Compiler diagnostics by default. The
      // dashboard intentionally keeps a few refs/effect synchronisation
      // patterns for polling and drag state, so these opt-outs preserve the
      // pre-compiler lint contract while the app remains on ordinary React.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
];
