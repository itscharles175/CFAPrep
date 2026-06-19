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
          '**/LsatRoot*',
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
