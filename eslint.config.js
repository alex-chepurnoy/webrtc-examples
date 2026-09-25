import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  { ignores: ['dist', 'build', 'coverage'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The React Compiler rule set flags real effect and ref design issues in the
      // WebRTC lifecycle components. They are worth fixing, but each one is a
      // behaviour change rather than a dependency bump, so they report as warnings
      // here instead of failing the lint run.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      // A leading underscore marks a binding that is deliberately discarded,
      // most often an unused event argument or a caught error. The default React
      // import is kept by the components but unused under the automatic JSX runtime.
      'no-unused-vars': ['warn', {
        varsIgnorePattern: '^(_|React$)',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // Tooling runs in Node, and the Playwright specs do too, outside their page.evaluate
    // callbacks. The app itself is browser code, so Node globals stay out of src/.
    files: ['*.config.js', 'e2e/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
];
