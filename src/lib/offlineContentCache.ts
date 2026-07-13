import { appRoutes } from '../routes/routeManifest';

export const OFFLINE_CONTENT_CACHE = 'quantvault-offline-content-v1';

export interface OfflineRouteReadiness {
  routeId: string;
  path: string;
  label: string;
  cached: boolean;
}

export interface OfflineReadinessReport {
  cacheName: string;
  cacheAvailable: boolean;
  generatedAt: string;
  criticalRoutes: OfflineRouteReadiness[];
  cachedCount: number;
  totalCriticalRoutes: number;
}

const criticalOfflineRoutes = appRoutes
  .filter((route) => route.offlineCritical)
  .map((route) => ({
    routeId: route.id,
    path: route.screenshotRoute || route.smokeRoute || route.path,
    label: route.navLabel,
  }));

function routeRequest(path: string) {
  return new Request(path, { credentials: 'same-origin' });
}

export async function cacheOfflineRoute(path: string) {
  if (typeof caches === 'undefined') return false;
  const cache = await caches.open(OFFLINE_CONTENT_CACHE);
  await cache.add(routeRequest(path));
  return true;
}

export async function cacheCriticalOfflineRoutes(paths = criticalOfflineRoutes.map((route) => route.path)) {
  if (typeof caches === 'undefined') return { cached: 0, failed: paths.length };
  const results = await Promise.allSettled(paths.map((path) => cacheOfflineRoute(path)));
  return {
    cached: results.filter((result) => result.status === 'fulfilled' && result.value).length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

export async function getOfflineReadinessReport(): Promise<OfflineReadinessReport> {
  if (typeof caches === 'undefined') {
    return {
      cacheName: OFFLINE_CONTENT_CACHE,
      cacheAvailable: false,
      generatedAt: new Date().toISOString(),
      criticalRoutes: criticalOfflineRoutes.map((route) => ({ ...route, cached: false })),
      cachedCount: 0,
      totalCriticalRoutes: criticalOfflineRoutes.length,
    };
  }

  const cache = await caches.open(OFFLINE_CONTENT_CACHE);
  const criticalRoutes = await Promise.all(
    criticalOfflineRoutes.map(async (route) => ({
      ...route,
      cached: Boolean(await cache.match(routeRequest(route.path))),
    })),
  );
  return {
    cacheName: OFFLINE_CONTENT_CACHE,
    cacheAvailable: true,
    generatedAt: new Date().toISOString(),
    criticalRoutes,
    cachedCount: criticalRoutes.filter((route) => route.cached).length,
    totalCriticalRoutes: criticalRoutes.length,
  };
}
