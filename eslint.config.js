// ESLint: catch undefined names, unused code and other likely bugs; layout
// is Prettier's job. Each file gets the globals of where it runs.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  // An empty catch is how this code says "ignore a malformed line or frame".
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
  { files: ['web/**'], languageOptions: { globals: globals.browser } },
  { files: ['web/sw.js'], languageOptions: { globals: globals.serviceworker } },
  {
    files: ['*.js', 'server/**', 'test/*.mjs'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.node } },
  },
  // The design test's page.evaluate() callbacks run in the browser.
  {
    files: ['test/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
];
