export const PRIVATE_CACHE_PATTERNS = [
  /^\/api(?:\/|$)/i,
  /^\/backup(?:s)?(?:\/|$)/i,
  /^\/export(?:s)?(?:\/|$)/i,
  /^\/source-vault(?:\/|$)/i,
  /^\/dist\/source-vault(?:\/|$)/i,
  /\.(?:qvsource|qvbackup)(?:$|[?#])/i,
  /(?:private[-_]?sentinel|source[-_]?sentinel|sentinel[-_]?private)/i,
];

function cacheUrl(input) {
  const origin =
    globalThis.self?.location?.origin ||
    globalThis.location?.origin ||
    'http://localhost';
  if (typeof input === 'string') return new URL(input, origin);
  if (input instanceof URL) return input;
  if (input && typeof input.url === 'string') return new URL(input.url, origin);
  return input;
}

export function isPrivateCacheUrl(input) {
  const url = cacheUrl(input);
  if (!url?.pathname) return false;
  const target = `${url.pathname}${url.search}`;
  return PRIVATE_CACHE_PATTERNS.some((pattern) => pattern.test(target));
}

export async function purgePrivateCacheEntries(cacheStorage = globalThis.caches) {
  if (!cacheStorage?.keys || !cacheStorage?.open) return 0;
  const cacheNames = await cacheStorage.keys();
  let deleted = 0;
  for (const cacheName of cacheNames) {
    const cache = await cacheStorage.open(cacheName);
    const requests = await cache.keys();
    for (const request of [...requests]) {
      if (isPrivateCacheUrl(new URL(request.url))) {
        if (await cache.delete(request)) deleted += 1;
      }
    }
  }
  return deleted;
}
