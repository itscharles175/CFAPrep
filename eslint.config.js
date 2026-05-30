import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  // `spike/` holds the gitignored open-notebook clone (its own nested eslint
  // config); `.claude/` and `src-tauri/target` are tooling/build artifacts.
  // `.venv-onb/` + `.pyinstaller-*` are the open-notebook PyInstaller sidecar
  // build dirs (Python venv site-packages ship bundled legacy JS that ESLint
  // would otherwise try — and fail — to lint). `data/` is the sidecar's
  // runtime working dir.
  {
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      'spike',
      '.claude',
      'src-tauri/target',
      '.venv-onb',
      '.pyinstaller-build',
      '.pyinstaller-dist',
      'data',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
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
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        sourceType: 'module',
      },
    },
  },
];
