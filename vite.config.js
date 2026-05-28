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
    exclude: ['**/node_modules/**', '**/dist/**', 'spike/**', '.claude/**', 'src-tauri/**'],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
