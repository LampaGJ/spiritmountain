import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'data/raw', 'reports', 'node_modules'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts', '*.config.ts', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'Use textContent or createElement; annotation text is untrusted.',
        },
        {
          property: 'outerHTML',
          message: 'Use textContent or createElement; annotation text is untrusted.',
        },
        {
          property: 'insertAdjacentHTML',
          message: 'Use textContent or createElement; annotation text is untrusted.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
          message: 'document.write is banned; build DOM with createElement and textContent.',
        },
      ],
    },
  },
);
