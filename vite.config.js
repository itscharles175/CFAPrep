import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        rollupFormat: 'iife',
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // Don't precache chunks a CFA/Quant/Excel-only user never loads: the
        // LSAT sub-app (only fetched on /lsat) and the heavy local-ML libs
        // (kokoro + transformers, ~2MB, only used for voice). They're still
        // served + runtime-cached on first use; this just keeps the install
        // footprint small. (Plan S3.)
        globIgnores: [
          '**/lsat-*',
          '**/kokoro*',
          '**/transformers*',
        ],
        // A few of these chunks exceed the default 2 MiB precache cap anyway;
        // raising the cap is unnecessary now that they're ignored.
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    open: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized.includes('level1Packs')) return 'cfa-level1-content';
          if (normalized.includes('level2Packs')) return 'cfa-level2-content';
          if (normalized.includes('level3Packs')) return 'cfa-level3-content';
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lucide-react')) return 'lucide-vendor';
          // Charts (Plan P6 / K4-3): the whole app now charts on @visx (the host
          // migrated off recharts in K4-3). visx + the host's direct
          // d3-scale/d3-scale-chromatic deps all pull the standalone d3-*
          // ecosystem, so fold the shared d3 core into ONE chunk so it isn't
          // scattered/duplicated across route chunks.
          if (id.includes('@visx')) return 'visx-vendor';
          if (/node_modules\/(d3-[\w-]+|internmap|delaunator|robust-predicates)\//.test(normalized)) {
            return 'd3-core-vendor';
          }
          if (id.includes('katex')) return 'katex';
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('react')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    // v8 coverage instrumentation (TEST-5, now always on in CI) roughly doubles
    // per-test runtime, pushing the heavier component + property suites past
    // vitest's 5s default timeout. Raise the ceiling so the always-coverage CI run
    // is stable; fast tests still finish fast. Inherited by both projects via
    // `extends: true`.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // TEST-5 (Wave 2 measurement substrate): coverage is a ROOT-level concern in a
    // vitest `projects` setup — it instruments the whole run, and thresholds are
    // global, not per-project. We measure the HOST surface (`src/**`, minus the
    // vendored LSAT subtree, tests, types and generated/data literals) and enforce
    // a NON-DECREASING FLOOR a few points below the measured numbers so it ratchets
    // up over time without going flaky. CI runs `npm run test:ci` (the `host`
    // project) with `--coverage`; the floor below is what fails the build. Measured
    // 2026-06-20 on `--project host` with this exact include/exclude + `all:true`:
    // stmts 51.69 / branches 40.61 / funcs 52.47 / lines 53.06 → floors set a few
    // points under each (whole numbers, so normal churn never trips them).
    coverage: {
      provider: 'v8',
      // `text` for the CI log, `json-summary` for a machine-readable artifact other
      // tools (and a future ratchet script) can read without re-parsing prose.
      reporter: ['text', 'json-summary'],
      reportsDirectory: './dist/reports/coverage',
      // Persist the report files even when the run has failing tests — otherwise
      // vitest computes coverage (and still enforces the floor) but skips WRITING
      // the json-summary, so CI couldn't upload the measurement artifact on a red
      // run. The floor is enforced regardless; this only affects the saved report.
      reportOnFailure: true,
      // Only the host application surface. `all: true` so untested host modules
      // count against the floor (otherwise coverage only reflects imported files
      // and silently inflates as tests are deleted).
      all: true,
      include: ['src/**'],
      exclude: [
        // Vendored LSAT subtree — it has its own `lsat` project + CI gate; folding
        // it in here would make the host floor depend on LSAT churn.
        'src/domains/lsat/**',
        // Test/spec/setup files measure nothing about the product.
        'src/**/*.{test,spec}.{js,jsx,ts,tsx}',
        'src/**/__tests__/**',
        'src/**/__integration__/**',
        'src/**/__mocks__/**',
        'src/setupTests.{js,ts}',
        // Type-only declarations have no runtime to cover.
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/*.types.ts',
        // Generated clients (codegen output — not authored, not our coverage to own).
        'src/**/api.gen.ts',
        // Static content/data literals (CFA packs, catalogs) are data, not logic.
        'src/data/**',
        'src/**/*Packs.{js,ts}',
        'src/domains/cfa/**/*Packs.{js,ts}',
        // Pure entry/bootstrap shims with no branching worth a floor.
        'src/main.jsx',
        'src/sw.js',
      ],
      // NON-DECREASING FLOOR (TEST-5). Set a few points below the measured numbers
      // so normal refactors don't trip it; raise these as coverage climbs.
      thresholds: {
        statements: 48,
        branches: 37,
        functions: 49,
        lines: 50,
      },
    },
    // Two vitest projects share this one config (and its `resolve.alias` +
    // react plugin via `extends: true`) so the vendored LSAT subtree runs on
    // the host's single hoisted toolchain (React 19 / vitest 4) — there is no
    // separate LSAT node_modules. Run all: `vitest run`; host-only (the fast
    // default): `--project host`; LSAT-only: `--project lsat`. (Plan S2.)
    projects: [
      {
        extends: true,
        test: {
          name: 'host',
          environment: 'jsdom',
          setupFiles: './src/setupTests.js',
          globals: true,
          // `spike/` holds the gitignored open-notebook clone with its own
          // test suite (and a colliding `@/` alias) — never run it here.
          // `src/domains/lsat/` is the LSAT project below.
          exclude: ['**/node_modules/**', '**/dist/**', 'spike/**', '.claude/**', 'src-tauri/**', 'src/domains/lsat/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'lsat',
          environment: 'jsdom',
          // The vendored subtree ships its own setup (jest-dom, localStorage
          // stub, `@lsat/lib/tauri` mock, fetch guard).
          setupFiles: './src/domains/lsat/test/setup.ts',
          globals: true,
          include: ['src/domains/lsat/**/*.{test,spec}.{ts,tsx}'],
          // The ContentOps cockpit tests drive long multi-step userEvent flows
          // that exceed the 5s default on a loaded machine; they pass with room
          // to spare at 25s. Integration-test budget, not a masked hang.
          testTimeout: 25000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      // The vendored LSAT domain (src/domains/lsat) uses '@lsat/' for its own
      // root — its original '@/' was rewritten to '@lsat/' on vendoring so it
      // doesn't collide with the host's '@/' → /src. Most-specific first.
      '@lsat': '/src/domains/lsat',
      '@': '/src',
    },
  },
});
