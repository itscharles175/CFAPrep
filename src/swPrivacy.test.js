import { describe, expect, it } from 'vitest';

import { isPrivateCacheUrl, purgePrivateCacheEntries } from './swPrivacy.js';

function request(url) {
  return { url };
}

function fakeCacheStorage(initial) {
  const buckets = new Map(
    Object.entries(initial).map(([name, urls]) => [
      name,
      urls.map((url) => request(url)),
    ]),
  );

  return {
    buckets,
    async keys() {
      return [...buckets.keys()];
    },
    async open(name) {
      return {
        async keys() {
          return buckets.get(name) || [];
        },
        async delete(item) {
          const entries = buckets.get(name) || [];
          const index = entries.indexOf(item);
          if (index < 0) return false;
          entries.splice(index, 1);
          return true;
        },
      };
    },
  };
}

describe('service-worker cache privacy guard', () => {
  it('identifies API, backups, exports, source bundles, and private sentinels', () => {
    expect(isPrivateCacheUrl('/api/observability/trust')).toBe(true);
    expect(isPrivateCacheUrl('/api')).toBe(true);
    expect(isPrivateCacheUrl('/exports/studyvault.json')).toBe(true);
    expect(isPrivateCacheUrl('/backup/latest.qvbackup')).toBe(true);
    expect(isPrivateCacheUrl('/source-vault/latest.qvsource')).toBe(true);
    expect(isPrivateCacheUrl('/dashboard?privateSentinel=abc')).toBe(true);
    expect(isPrivateCacheUrl('/assets/app.js')).toBe(false);
    expect(isPrivateCacheUrl('https://app.local/assets/app.css')).toBe(false);
  });

  it('purges private requests from all cache buckets and leaves public assets', async () => {
    const storage = fakeCacheStorage({
      pages: [
        'https://studyvault.local/dashboard',
        'https://studyvault.local/api/observability/trust',
        'https://studyvault.local/export/studyvault.json',
      ],
      images: [
        'https://studyvault.local/assets/logo.png',
        'https://studyvault.local/source-vault/latest.qvsource',
      ],
      static: [
        'https://studyvault.local/assets/app.js',
        'https://studyvault.local/assets/source-sentinel-private.css',
      ],
    });

    await expect(purgePrivateCacheEntries(storage)).resolves.toBe(4);

    expect(storage.buckets.get('pages').map((entry) => entry.url)).toEqual([
      'https://studyvault.local/dashboard',
    ]);
    expect(storage.buckets.get('images').map((entry) => entry.url)).toEqual([
      'https://studyvault.local/assets/logo.png',
    ]);
    expect(storage.buckets.get('static').map((entry) => entry.url)).toEqual([
      'https://studyvault.local/assets/app.js',
    ]);
  });

  it('no-ops when Cache Storage is unavailable', async () => {
    await expect(purgePrivateCacheEntries(undefined)).resolves.toBe(0);
  });
});
