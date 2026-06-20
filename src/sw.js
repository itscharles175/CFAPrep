/**
 * B5: Workbox-powered service worker with build-manifest precaching.
 *
 * In production, Vite replaces __WB_MANIFEST with the actual file list.
 * In development, this SW is not registered.
 */
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

const OFFLINE_CONTENT_CACHE = 'quantvault-offline-content-v1';

// Precache all Vite build output (injected at build time)
precacheAndRoute(self.__WB_MANIFEST || []);
cleanupOutdatedCaches();

// Note: previous versions also registered CDN cache routes for Google Fonts
// (fonts.googleapis.com/gstatic.com) and KaTeX CSS (cdn.jsdelivr.net). Those
// CDN <link> tags have been removed from index.html — KaTeX CSS is now
// bundled locally via the `katex` npm package (imported in main.jsx) and
// fonts fall through to the OS system stack. The strict-offline invariant
// means we never reach out to any third-party origin, so no runtime cache
// for them is needed.

// Cache images
registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: 'images',
    plugins: [
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);

const navigationStrategy = new NetworkFirst({
  cacheName: 'pages',
  plugins: [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
  ],
});

// SPA navigation — network first, then explicit offline route cache, then app shell
registerRoute(
  ({ request }) => request.mode === 'navigate',
  async ({ event, request }) => {
    try {
      return await navigationStrategy.handle({ event, request });
    } catch {
      const offlineCache = await caches.open(OFFLINE_CONTENT_CACHE);
      const url = new URL(request.url);
      // Prod-readiness fix: the SPA shell is precached under a REVISIONED key
      // (`index.html?__WB_REVISION__=…`), so a bare `caches.match('/index.html')`
      // misses it — a cold-offline deep-link (e.g. /dashboard, /lsat) then fell
      // through to Response.error() = blank document. matchPrecache() resolves the
      // revisioned key; offline.html (also precached) is the final styled fallback.
      return (
        (await offlineCache.match(request)) ||
        (await offlineCache.match(url.pathname)) ||
        (await matchPrecache('index.html')) ||
        (await matchPrecache('offline.html')) ||
        Response.error()
      );
    }
  },
);

// Static assets (JS, CSS) — stale-while-revalidate
registerRoute(
  ({ request }) => ['script', 'style'].includes(request.destination),
  new StaleWhileRevalidate({
    cacheName: 'static-assets',
    plugins: [
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);

// Skip waiting and claim clients on update
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'CACHE_VERSION', version: 'workbox-v1' });
  }
});

self.addEventListener('activate', () => {
  self.clients.claim();
});
