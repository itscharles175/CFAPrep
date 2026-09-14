import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LSAT_SIDECAR_SERVICE_NAME,
  bootstrapLsatSidecarAuthToken,
  buildLsatSidecarUrl,
  fetchLsatSidecar,
  fetchLsatSidecarJson,
  getLsatSidecarAuthToken,
  setLsatSidecarAuthToken,
  withLsatSidecarAuthHeaders,
} from './lsatSidecarClient';
import type { StudyVaultBootStatus, StudyVaultBridge, StudyVaultSidecarStatus } from './desktopBridge';

function sidecarRow(ready: boolean): StudyVaultSidecarStatus {
  return {
    name: LSAT_SIDECAR_SERVICE_NAME,
    port: 8100,
    ready_port: 8100,
    healthy: ready,
    ready,
    depends_on: [],
    pid: ready ? 1234 : null,
    optional: false,
    present: true,
    blocked: false,
    block_reason: null,
    provenance_status: 'ok',
    state: ready ? 'ready' : 'starting',
    restart_count: 0,
  };
}

function installElectronBridge(
  options: {
    status?: () => Promise<StudyVaultSidecarStatus[]>;
    onBootStatus?: StudyVaultBridge['events']['onBootStatus'];
  } = {},
): void {
  const unsubscribe = () => undefined;
  const status = options.status ?? (async () => [sidecarRow(true)]);
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
        native_shell: 'macos-unified',
        release_tier: 'personal',
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
      status,
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
      onBootStatus: options.onBootStatus ?? (() => unsubscribe),
      onSecondInstance: () => unsubscribe,
      onOpenFile: () => unsubscribe,
      onPdfDrop: () => unsubscribe,
      onLifecycle: () => unsubscribe,
      onNativeNavigate: () => unsubscribe,
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

  it('gates the Electron bootstrap until the LSAT sidecar reports ready', async () => {
    const rows = vi.fn(async () => [sidecarRow(false)]);
    installElectronBridge({ status: rows });

    const pending = bootstrapLsatSidecarAuthToken({ timeoutMs: 1000 });
    await Promise.resolve();
    rows.mockImplementation(async () => [sidecarRow(true)]);

    expect(await pending).toEqual({ ok: true, skipped: true, tokenInjected: false });
    expect(rows.mock.calls.length).toBeGreaterThan(1);
  });

  it('resolves the Electron bootstrap from the boot-status event', async () => {
    const handlers: ((status: StudyVaultBootStatus) => void)[] = [];
    let ready = false;
    installElectronBridge({
      status: async () => [sidecarRow(ready)],
      onBootStatus: (handler) => {
        handlers.push(handler);
        return () => {
          handlers.splice(handlers.indexOf(handler), 1);
        };
      },
    });

    // Long enough that only the event/poll path — never the timeout — can settle it.
    const pending = bootstrapLsatSidecarAuthToken({ timeoutMs: 5000 });
    await Promise.resolve();
    ready = true;
    for (const handler of [...handlers]) {
      handler({
        status: 'ok',
        launched: 1,
        skipped: 0,
        blocked: 0,
        skipped_names: [],
        blocked_names: [],
        degraded_reason: '',
      });
    }

    expect(await pending).toEqual({ ok: true, skipped: true, tokenInjected: false });
    expect(handlers).toHaveLength(0);
  });

  it('reports a bounded sidecar-not-ready error instead of hanging the root mount', async () => {
    installElectronBridge({ status: async () => [sidecarRow(false)] });

    const result = await bootstrapLsatSidecarAuthToken({ timeoutMs: 30 });

    expect(result).toEqual({ ok: false, skipped: true, tokenInjected: false, error: 'sidecar not ready' });
    expect(getLsatSidecarAuthToken()).toBeNull();
  });

  it('treats an unreadable sidecar status bridge as not ready', async () => {
    installElectronBridge({
      status: async () => {
        throw new Error('IPC channel closed');
      },
      onBootStatus: () => {
        throw new Error('missing preload surface');
      },
    });

    const result = await bootstrapLsatSidecarAuthToken({ timeoutMs: 30 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('sidecar not ready');
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
