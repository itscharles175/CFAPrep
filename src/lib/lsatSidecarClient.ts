/**
 * Shared host-side transport for the LSAT backend sidecar.
 *
 * The backend can optionally require a per-run local API token. Browser/dev
 * builds may provide it through `VITE_LSATLAB_LOCAL_API_TOKEN`. In Electron the
 * bearer remains main-process-only and is injected for the exact loopback origin
 * by the session webRequest hook. This module never persists a token.
 */
import { buildLoopbackHttpUrl, normalizeLoopbackHttpBaseUrl } from './localUrlPolicy';
import { getDesktopBridge } from './desktopBridge';

export const DEFAULT_LSAT_SIDECAR_BASE = 'http://127.0.0.1:8100';
export const LSAT_SIDECAR_AUTH_BOOTSTRAP_TIMEOUT_MS = 2000;

const IN_MEMORY_TOKEN_KEYS = ['__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__', '__LSATLAB_LOCAL_API_TOKEN__'] as const;

declare global {
  interface Window {
    __STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__?: string;
    __LSATLAB_LOCAL_API_TOKEN__?: string;
  }
}

type FetchInitWithTimeout = RequestInit & { timeoutMs?: number };

export interface LsatSidecarAuthBootstrapResult {
  ok: boolean;
  skipped: boolean;
  tokenInjected: boolean;
  error?: string;
}

export interface LsatSidecarJsonResult<T = unknown> {
  ok: boolean;
  reachable: boolean;
  status: number;
  data: T | null;
  error?: string;
}

function envValue(name: string): string | undefined {
  return (import.meta.env as unknown as Record<string, string | undefined>)[name];
}

function cleanToken(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getLsatSidecarBase(): string {
  const base =
    cleanToken(envValue('VITE_LSAT_API_BASE')) ?? cleanToken(envValue('VITE_API_BASE')) ?? DEFAULT_LSAT_SIDECAR_BASE;
  return normalizeLoopbackHttpBaseUrl(base, 'LSAT sidecar base URL');
}

function getLsatSidecarInMemoryAuthToken(): string | null {
  if (typeof window !== 'undefined') {
    for (const key of IN_MEMORY_TOKEN_KEYS) {
      const token = cleanToken(window[key]);
      if (token) return token;
    }
  }
  return null;
}

export function getLsatSidecarAuthToken(): string | null {
  if (getDesktopBridge()) return null;
  const inMemoryToken = getLsatSidecarInMemoryAuthToken();
  if (inMemoryToken) {
    return inMemoryToken;
  }
  return cleanToken(envValue('VITE_LSATLAB_LOCAL_API_TOKEN'));
}

export function setLsatSidecarAuthToken(value: unknown): boolean {
  if (typeof window === 'undefined') return false;
  if (getDesktopBridge()) {
    for (const key of IN_MEMORY_TOKEN_KEYS) delete window[key];
    return false;
  }
  const token = cleanToken(value);
  if (!token) {
    for (const key of IN_MEMORY_TOKEN_KEYS) delete window[key];
    return false;
  }
  window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = token;
  return true;
}

export async function bootstrapLsatSidecarAuthToken(options?: {
  timeoutMs?: number;
}): Promise<LsatSidecarAuthBootstrapResult> {
  const bridge = getDesktopBridge();
  if (bridge) {
    for (const key of IN_MEMORY_TOKEN_KEYS) delete window[key];
    return { ok: true, skipped: true, tokenInjected: false };
  }
  if (getLsatSidecarInMemoryAuthToken()) {
    return { ok: true, skipped: true, tokenInjected: true };
  }
  void options;
  return { ok: true, skipped: true, tokenInjected: Boolean(getLsatSidecarAuthToken()) };
}

export function withLsatSidecarAuthHeaders(headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  const token = getLsatSidecarAuthToken();
  if (token && !out.has('authorization') && !out.has('x-lsatlab-api-token')) {
    out.set('Authorization', `Bearer ${token}`);
  }
  return out;
}

export function buildLsatSidecarUrl(path: string): string {
  return buildLoopbackHttpUrl(getLsatSidecarBase(), path, 'LSAT sidecar URL');
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

function signalWithTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (!callerSignal && timeoutMs == null) return { signal: undefined, cleanup: () => {} };

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(callerSignal?.reason ?? abortError());
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  if (timeoutMs != null) {
    timeoutId = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(abortError());
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId != null) clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export async function fetchLsatSidecar(path: string, init: FetchInitWithTimeout = {}): Promise<Response> {
  const { timeoutMs, headers, signal: callerSignal, ...rest } = init;
  const merged = signalWithTimeout(callerSignal ?? undefined, timeoutMs);
  try {
    return await fetch(buildLsatSidecarUrl(path), {
      ...rest,
      signal: merged.signal,
      headers: withLsatSidecarAuthHeaders(headers),
    });
  } finally {
    merged.cleanup();
  }
}

export async function fetchLsatSidecarJson<T = unknown>(
  path: string,
  init: FetchInitWithTimeout = {},
): Promise<LsatSidecarJsonResult<T>> {
  try {
    const res = await fetchLsatSidecar(path, init);
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { ok: res.ok, reachable: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      status: 0,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
