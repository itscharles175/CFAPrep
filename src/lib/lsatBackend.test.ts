import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLsatBackendHealth, syncProviderToLsat, LSAT_SETTINGS_PATH } from './lsatBackend';

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

  it('surfaces effective model routing + missing models (S5-A)', async () => {
    stubFetch({
      '/api/health': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/ai/health': () =>
        new Response(
          JSON.stringify({
            ok: true,
            provider: 'lmstudio',
            explain_model: 'phi4:14b',
            gen_model: 'qwen3:14b',
            diagnose_model: 'qwen3:8b',
            missing_models: ['phi4:14b'],
          }),
          { status: 200 },
        ),
    });
    const h = await checkLsatBackendHealth();
    expect(h.ai?.models).toEqual({ explain: 'phi4:14b', gen: 'qwen3:14b', diagnose: 'qwen3:8b' });
    expect(h.ai?.missingModels).toEqual(['phi4:14b']);
  });

  it('omits models/missingModels when the backend reports none', async () => {
    stubFetch({
      '/api/health': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/ai/health': () => new Response(JSON.stringify({ ok: true, provider: 'ollama' }), { status: 200 }),
    });
    const h = await checkLsatBackendHealth();
    expect(h.ai?.models).toBeUndefined();
    expect(h.ai?.missingModels).toBeUndefined();
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

describe('syncProviderToLsat (S5-B)', () => {
  it('maps an Ollama host URL to local_provider=ollama (no url field)', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const r = await syncProviderToLsat({ baseUrl: 'http://localhost:11434/v1' });
    expect(r.ok).toBe(true);
    expect(r.applied?.local_provider).toBe('ollama');
    expect(r.applied?.lmstudio_url).toBeUndefined();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ local_provider: 'ollama' });
    expect(init.method).toBe('PUT');
  });

  it('maps an LM Studio host URL to local_provider=lmstudio + lmstudio_url', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const r = await syncProviderToLsat({ baseUrl: 'http://localhost:1234/v1' });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual({ local_provider: 'lmstudio', lmstudio_url: 'http://localhost:1234/v1' });
  });

  it('returns ok:false (no request) when no host URL is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const r = await syncProviderToLsat({ baseUrl: '' });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:false when the backend rejects the update', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 422 }))) as unknown as typeof fetch);
    const r = await syncProviderToLsat({ baseUrl: 'http://localhost:1234/v1' });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/422/);
  });
});
