import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  bootstrapLsatSidecarAuthToken,
  buildLsatSidecarUrl,
  fetchLsatSidecar,
  fetchLsatSidecarJson,
  getLsatSidecarAuthToken,
  setLsatSidecarAuthToken,
  withLsatSidecarAuthHeaders,
} from './lsatSidecarClient';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

afterEach(() => {
  delete window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__;
  delete window.__LSATLAB_LOCAL_API_TOKEN__;
  delete window.__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('lsatSidecarClient', () => {
  it('builds absolute sidecar URLs from API paths', () => {
    expect(buildLsatSidecarUrl('/api/health')).toBe('http://127.0.0.1:8100/api/health');
  });

  it('rejects absolute remote sidecar URLs before fetch', () => {
    expect(() => buildLsatSidecarUrl('https://api.example.com/api/health')).toThrow(
      /loopback/i,
    );
  });

  it('adds the in-memory local API token as a bearer header', async () => {
    window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = 'run-token';
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await fetchLsatSidecar('/api/preptests', { headers: { accept: 'application/json' } });

    const init = fetchMock.mock.calls[0]?.[1] ?? {};
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer run-token');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('uses the legacy in-memory token key as a fallback', () => {
    window.__LSATLAB_LOCAL_API_TOKEN__ = 'legacy-token';
    const headers = withLsatSidecarAuthHeaders();
    expect(headers.get('authorization')).toBe('Bearer legacy-token');
  });

  it('sets and clears the primary in-memory token without persistence', () => {
    window.__LSATLAB_LOCAL_API_TOKEN__ = 'legacy-token';

    expect(setLsatSidecarAuthToken(' run-token ')).toBe(true);
    expect(window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__).toBe('run-token');
    expect(getLsatSidecarAuthToken()).toBe('run-token');

    expect(setLsatSidecarAuthToken('  ')).toBe(false);
    expect(window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__).toBeUndefined();
    expect(window.__LSATLAB_LOCAL_API_TOKEN__).toBeUndefined();
  });

  it('bootstraps the run token from Tauri before sidecar requests start', async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue(' native-token ');

    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toEqual({ ok: true, skipped: false, tokenInjected: true });
    expect(invoke).toHaveBeenCalledWith('get_lsat_local_api_token');
    expect(getLsatSidecarAuthToken()).toBe('native-token');
  });

  it('does not invoke Tauri when a token is already available in memory', async () => {
    window.__TAURI_INTERNALS__ = {};
    setLsatSidecarAuthToken('existing-token');

    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toEqual({ ok: true, skipped: true, tokenInjected: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(getLsatSidecarAuthToken()).toBe('existing-token');
  });

  it('skips token bootstrap outside the Tauri runtime', async () => {
    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toEqual({ ok: true, skipped: true, tokenInjected: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('degrades token bootstrap failures without throwing or persisting a value', async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('command unavailable'));

    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toMatchObject({
      ok: false,
      skipped: false,
      tokenInjected: false,
      error: 'command unavailable',
    });
    expect(getLsatSidecarAuthToken()).toBeNull();
  });

  it('does not overwrite an explicit auth header', () => {
    window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = 'run-token';
    const headers = withLsatSidecarAuthHeaders({ Authorization: 'Bearer explicit' });
    expect(headers.get('authorization')).toBe('Bearer explicit');
  });

  it('does not overwrite an explicit X-LSATLAB-API-Token header', () => {
    window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = 'run-token';
    const headers = withLsatSidecarAuthHeaders({ 'X-LSATLAB-API-Token': 'explicit-token' });
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-lsatlab-api-token')).toBe('explicit-token');
  });

  it('degrades JSON requests to reachable:false on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    const result = await fetchLsatSidecarJson('/api/preptests');
    expect(result.ok).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
