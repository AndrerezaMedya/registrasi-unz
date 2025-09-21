// Flat ESLint config for registrasi-unz-api (ESLint v9)
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import promise from 'eslint-plugin-promise';

const tsconfigRoot = process.cwd(); // use current working directory path string

export default [
  {
    files: ['src/**/*.ts'],
    ignores: [
      'node_modules/**',
      'dist/**',
      'public/**',
      '.wrangler/**',
      'coverage/**',
      '**/*.d.ts'
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: tsconfigRoot
      },
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Cloudflare Workers runtime & standard web APIs available globally
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        WebSocket: 'readonly',
        WebSocketPair: 'readonly',
        DurableObject: 'readonly',
        DurableObjectState: 'readonly',
        DurableObjectNamespace: 'readonly',
        ExecutionContext: 'readonly',
        ScheduledController: 'readonly',
  ExportedHandler: 'readonly',
  Env: 'readonly',
  MessageEvent: 'readonly',
  D1Database: 'readonly',
        console: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      promise
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      // Import plugin base recommendations (manually pick core ones)
      'import/order': ['warn', { 'newlines-between': 'always', groups: ['builtin','external','internal','parent','sibling','index'] }],
      'import/no-unresolved': 'error',

      // Promise best practices
      'promise/param-names': 'error',

      // TypeScript specific overrides
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': ['warn', { ignoreRestArgs: true }],

      // General safety
      'eqeqeq': ['error','always'],
      // Relax curly to multi-line to avoid massive refactor right now
      'curly': ['error','multi-line'],
      'no-console': 'off',
      // Allow intentional empty catch blocks with a comment
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Allow TODO for ts-ignore migration
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-ignore': 'allow-with-description' }],
      'no-useless-escape': 'warn'
    }
  }
];
