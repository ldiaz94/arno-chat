// ESLint: catch undefined names, unused code and other likely bugs; layout
// is Prettier's job. Each file gets the globals of where it runs.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  { files: ['web/**'], languageOptions: { globals: globals.browser } },
  {
    files: ['*.js', '*.mjs'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.node } },
  },
  { files: ['*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
];
