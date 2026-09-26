import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'off',
      eqeqeq: 'error',
      'no-throw-literal': 'error',
      curly: 'error',
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  },
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'esbuild.js']
  }
];
