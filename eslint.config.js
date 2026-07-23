import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  // `spike/` holds the gitignored open-notebook clone (its own nested eslint
  // config); `.claude/` and Electron release folders are tooling/build artifacts.
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
      '.gitnexus',
      'release',
      'release-debug',
      'release-ci',
      'release-config-check',
      '.venv-onb',
      '.pyinstaller-build',
      '.pyinstaller-dist',
      'data',
      // Vendored LSAT domain: React-18/TS-5.6 subtree with its own toolchain
      // conventions (Tailwind, @/ alias → its own root). Linted by its own
      // config during the merge port, not the host's strict flat config.
      'src/domains/lsat',
      '.venv-lsat',
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
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
  // Electron main process + preload: Node, not browser. These must come after
  // the `**/*.{js,jsx}` block so they replace its browser globals — otherwise
  // `process`/`require`/`__dirname` typos lint clean. `.cjs` is CommonJS
  // (preload/watchdog) while `.js` is ESM under the root `"type": "module"`.
  {
    files: ['electron/**/*.js', 'electron/tests/**/*.mjs'],
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
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
  },
];
