import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// web 前端 lint（flat config，eslint 9）
export default [
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      globals: { AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', window: 'readonly', document: 'readonly', WebSocket: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' },
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react/jsx-uses-vars': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': 'warn',
    },
  },
];
