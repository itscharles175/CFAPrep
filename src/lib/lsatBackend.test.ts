import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLsatBackendHealth, LSAT_SETTINGS_PATH } from './lsatBackend';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      for (const [frag, fn] of Object.entries(routes)) {
        if (url.includes(frag)) return Promise.resolve(fn());
      }
      return Promise.reject(new Error(`unrouted ${url}`));
    }) as unknown as typeof fetch,
  );
}

describe('checkLsatBackendHealth', () => {
  it('reports healthy when /api/health is 2xx', async () => {
    stubFetch({
      '/api/health': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/ai/health': () => new Response(JSON.stringify({ ok: true, provider: 'ollama' }), { status: 200 }),
    });
    const h = await checkLsatBackendHealth();
    expect(h.ok).toBe(true);
    expect(h.reachable).toBe(true);
    expect(h.ai?.provider).toBe('ollama');
    expect(h.detail).toMatch(/healthy/i);
  });

  it('still reports healthy if /api/ai/health is absent (older backend)', async () => {
    stubFetch({
      '/api/health': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/ai/health': () => new Response('not found', { status: 404 }),
    });
    const h = await checkLsatBackendHealth();
    expect(h.ok).toBe(true);
    expect(h.ai).toBeUndefined();
  });

  it('flags "up but provider down" when ai health is not ready', async () => {
    stubFetch({
      '/api/health': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/ai/health': () => new Response(JSON.stringify({ ok: false, provider: 'ollama', detail: 'no models' }), { status: 200 }),
    });
    const h = await checkLsatBackendHealth();
    expect(h.ok).toBe(true);
    expect(h.ai?.ready).toBe(false);
    expect(h.detail).toMatch(/provider not reachable/i);
  });

  it('reports offline (no throw) when the sidecar is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    const h = await checkLsatBackendHealth();
    expect(h.ok).toBe(false);
    expect(h.reachable).toBe(false);
    expect(h.detail).toMatch(/offline/i);
  });

  it('reports offline on a non-2xx health response', async () => {
    stubFetch({ '/api/health': () => new Response('boom', { status: 503 }) });
    const h = await checkLsatBackendHealth();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/503/);
  });

  it('exposes the LSAT settings deep-link path', () => {
    expect(LSAT_SETTINGS_PATH).toBe('/lsat/settings');
  });
});
