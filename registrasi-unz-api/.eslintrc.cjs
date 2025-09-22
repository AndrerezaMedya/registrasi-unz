/* ESLint config for registrasi-unz-api */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module'
  },
  env: {
    es2022: true,
    worker: true
  },
  plugins: [
    '@typescript-eslint',
    'import',
    'promise'
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:promise/recommended'
  ],
  settings: {
  },
  rules: {
    // Style / consistency
    '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    'import/order': ['warn', { 'newlines-between': 'always', groups: ['builtin','external','internal','parent','sibling','index'] }],

    // Unused vars: allow underscore prefix
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

    // Promises
    'promise/always-return': 'off',
    'promise/no-nesting': 'off',

    // General safety
    'eqeqeq': ['error','always'],
    'curly': ['error','all'],

    // Allow console (Worker environment relies on logs)
    'no-console': 'off'
  }
};
