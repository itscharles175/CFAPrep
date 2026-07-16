import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapLsatSidecarAuthToken,
  buildLsatSidecarUrl,
  fetchLsatSidecar,
  fetchLsatSidecarJson,
  getLsatSidecarAuthToken,
  setLsatSidecarAuthToken,
  withLsatSidecarAuthHeaders,
} from './lsatSidecarClient';
import type { StudyVaultBridge } from './desktopBridge';

function installElectronBridge(): void {
  const unsubscribe = () => undefined;
  window.studyvault = {
    runtime: {
      info: async () => ({
        app_version: 'test',
        electron_version: 'test',
        chrome_version: 'test',
        node_version: 'test',
        platform: 'win32',
        arch: 'x64',
        is_packaged: false,
      }),
    },
    files: {
      pickFolder: async () => null,
      pickFiles: async () => [],
      listPdfs: async () => [],
      read: async (path) => ({
        path,
        name: 'file.pdf',
        extension: '.pdf',
        size: 0,
        data: new Uint8Array(),
      }),
    },
    sidecar: {
      status: async () => [],
      logs: async () => [],
      aggregate: async () => ({
        status: 'ok',
        ready: 0,
        required_down: 0,
        optional_down: 0,
        total: 0,
        required_down_names: [],
      }),
    },
    keychain: {
      get: async () => null,
      set: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
    openPath: async () => ({ opened: true, error: '' }),
    openExternal: async () => ({ opened: true }),
    popout: async () => ({ id: 1 }),
    notification: async () => ({ shown: true }),
    fullscreen: {
      get: async () => false,
      set: async (value) => value,
    },
    events: {
      onBootStatus: () => unsubscribe,
      onSecondInstance: () => unsubscribe,
      onOpenFile: () => unsubscribe,
      onPdfDrop: () => unsubscribe,
    },
  } satisfies StudyVaultBridge;
}

afterEach(() => {
  delete window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__;
  delete window.__LSATLAB_LOCAL_API_TOKEN__;
  delete window.studyvault;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('lsatSidecarClient', () => {
  it('builds absolute sidecar URLs from API paths', () => {
    expect(buildLsatSidecarUrl('/api/health')).toBe('http://127.0.0.1:8100/api/health');
  });

  it('rejects absolute remote sidecar URLs before fetch', () => {
    expect(() => buildLsatSidecarUrl('https://api.example.com/api/health')).toThrow(/loopback/i);
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

  it('keeps Electron sidecar authentication main-process-only', async () => {
    window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = 'stale-renderer-token';
    installElectronBridge();

    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toEqual({ ok: true, skipped: true, tokenInjected: false });
    expect(window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__).toBeUndefined();
    expect(getLsatSidecarAuthToken()).toBeNull();
    expect(withLsatSidecarAuthHeaders().has('authorization')).toBe(false);
  });

  it('keeps an explicitly supplied token in browser memory', async () => {
    setLsatSidecarAuthToken('existing-token');

    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toEqual({ ok: true, skipped: true, tokenInjected: true });
    expect(getLsatSidecarAuthToken()).toBe('existing-token');
  });

  it('skips token bootstrap in browser dev when no explicit token exists', async () => {
    const result = await bootstrapLsatSidecarAuthToken();

    expect(result).toEqual({ ok: true, skipped: true, tokenInjected: false });
  });

  it('rejects renderer token setters while the Electron bridge is present', () => {
    installElectronBridge();
    expect(setLsatSidecarAuthToken('renderer-token')).toBe(false);
    expect(getLsatSidecarAuthToken()).toBeNull();
    expect(window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__).toBeUndefined();
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
