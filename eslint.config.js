import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/',
      '.astro/',
      'node_modules/',
      'data/',
      'coverage/',
      'test-results/',
      'playwright-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  ...astro.configs['jsx-a11y-strict'],
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      // Label text is often nested a few elements deep (label > span > span).
      'astro/jsx-a11y/label-has-associated-control': ['error', { depth: 4 }],
    },
  },
  {
    // Astro's ambient declarations must use inline import() types: a top-level
    // import would turn the file into a module and break the global App namespace.
    files: ['src/env.d.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Raw HTML may only be rendered by src/components/Markdown.astro, which
    // accepts the branded `SafeHtml` type produced by the Markdown renderer.
    // Any other `set:html` use fails lint.
    files: ['**/*.astro'],
    rules: {
      'astro/no-set-html-directive': 'error',
    },
  },
];
