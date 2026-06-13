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
          if (id.includes('recharts')) return 'recharts-vendor';
          if (id.includes('katex')) return 'katex';
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('react')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/setupTests.js',
    globals: true,
    // `spike/` holds the gitignored open-notebook clone with its own test
    // suite (and an `@/` alias that collides with ours) — never run it here.
    // `src/domains/lsat/` is the vendored LSAT subtree (React-18/Vitest-2 era
    // tests with the same colliding `@/` alias) — run under its own config.
    exclude: ['**/node_modules/**', '**/dist/**', 'spike/**', '.claude/**', 'src-tauri/**', 'src/domains/lsat/**'],
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
