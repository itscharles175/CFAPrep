// GAP-QUOTA-1 — IndexedDB durability against eviction + quota pressure.
//
// IndexedDB is best-effort by default: under storage pressure a browser /
// WebView can EVICT the entire origin, silently destroying the user's only
// copy of the vault (this app has no cloud backup). And a write that crosses
// the quota ceiling throws `QuotaExceededError`, which can leave a multi-step
// operation half-applied.
//
// This module hardens both edges WITHOUT any decision-making:
//   - requestPersistentStorage() asks the browser to mark the origin
//     "persistent" so it is exempt from eviction under pressure.
//   - estimateStoragePressure() reports how close the vault is to its quota so
//     callers can warn before writes start failing.
//   - isQuotaExceededError() classifies a thrown error across engines so the
//     write path can react specifically to "out of space".
//
// Everything here is fully OFFLINE and degrades gracefully: the Storage API
// (`navigator.storage`) is absent in older WebViews, in some private-mode
// contexts, and in the test/SSR environment. Every entry point is guarded so
// it never throws on absence — it returns a safe "unknown" result instead.

/** Granted-state of `navigator.storage.persist()` / `.persisted()`. */
export type PersistenceState =
  /** The Storage API granted (or already had) persistent storage. */
  | 'persisted'
  /** The API is present but the browser declined to grant persistence. */
  | 'denied'
  /** The Storage API (or `persist`/`persisted`) is unavailable here. */
  | 'unsupported';

/** Coarse pressure level derived from `estimate()`. */
export type StoragePressureLevel = 'ok' | 'warn' | 'critical' | 'unknown';

export interface StoragePressure {
  /** Bytes currently used by this origin, or null when unavailable. */
  usageBytes: number | null;
  /** Total bytes available to this origin, or null when unavailable. */
  quotaBytes: number | null;
  /** usage/quota in the range 0..1, or null when it can't be computed. */
  pct: number | null;
  /** Bucketed level for UI: 'unknown' when the estimate is unavailable. */
  level: StoragePressureLevel;
}

/** Warn at >= 80% of quota used. */
export const PRESSURE_WARN_THRESHOLD = 0.8;
/** Critical at >= 95% of quota used — writes are at real risk of failing. */
export const PRESSURE_CRITICAL_THRESHOLD = 0.95;

/**
 * Returns the `StorageManager` if (and only if) the Storage API is usable in
 * this environment, else `undefined`. Guards `navigator` itself so this is
 * safe under SSR / Node test runs as well as old WebViews.
 */
function getStorageManager(): StorageManager | undefined {
  try {
    if (typeof navigator === 'undefined') return undefined;
    return navigator.storage ?? undefined;
  } catch {
    // Some sandboxed contexts throw on `navigator.storage` access.
    return undefined;
  }
}

/**
 * Ask the browser to mark this origin's storage as persistent so it is exempt
 * from eviction under storage pressure.
 *
 * Idempotent and safe to call on every boot: if the origin is already
 * persisted the call is a cheap no-op that re-confirms `'persisted'`. Never
 * throws — on absence or any internal error it resolves to `'unsupported'`.
 *
 * Note: a browser may grant persistence without a prompt (e.g. for installed /
 * high-engagement origins) or silently decline; callers must treat `'denied'`
 * as "best-effort eviction protection only" rather than an error.
 */
export async function requestPersistentStorage(): Promise<PersistenceState> {
  const storage = getStorageManager();
  if (!storage || typeof storage.persist !== 'function') return 'unsupported';
  try {
    // Short-circuit if already persisted so repeated boots don't re-prompt.
    if (typeof storage.persisted === 'function') {
      try {
        if (await storage.persisted()) return 'persisted';
      } catch {
        /* fall through to persist() — `persisted()` failing is non-fatal */
      }
    }
    const granted = await storage.persist();
    return granted ? 'persisted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/**
 * Report whether the origin's storage is currently persisted (eviction-exempt).
 * Never throws; resolves to `false` when the API is unavailable or errors.
 */
export async function isPersisted(): Promise<boolean> {
  const storage = getStorageManager();
  if (!storage || typeof storage.persisted !== 'function') return false;
  try {
    return await storage.persisted();
  } catch {
    return false;
  }
}

/** Classify a usage/quota ratio into a coarse pressure level. */
function classifyPressure(pct: number | null): StoragePressureLevel {
  if (pct == null || !Number.isFinite(pct)) return 'unknown';
  if (pct >= PRESSURE_CRITICAL_THRESHOLD) return 'critical';
  if (pct >= PRESSURE_WARN_THRESHOLD) return 'warn';
  return 'ok';
}

const UNKNOWN_PRESSURE: StoragePressure = {
  usageBytes: null,
  quotaBytes: null,
  pct: null,
  level: 'unknown',
};

/**
 * Estimate how close this origin is to its storage quota.
 *
 * Returns a fully-populated {@link StoragePressure} with `level: 'unknown'`
 * (and null numbers) whenever the Storage API or its `estimate()` is
 * unavailable, the estimate is malformed, or the quota is zero — never throws.
 */
export async function estimateStoragePressure(): Promise<StoragePressure> {
  const storage = getStorageManager();
  if (!storage || typeof storage.estimate !== 'function') return { ...UNKNOWN_PRESSURE };
  let estimate: StorageEstimate;
  try {
    estimate = await storage.estimate();
  } catch {
    return { ...UNKNOWN_PRESSURE };
  }
  const usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null;
  const quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null;
  const pct =
    usageBytes != null && quotaBytes != null && quotaBytes > 0
      ? usageBytes / quotaBytes
      : null;
  return { usageBytes, quotaBytes, pct, level: classifyPressure(pct) };
}

// DOMException code for QuotaExceededError on legacy engines (the `code`
// numeric constant predates `name`; some old WebKit/Gecko builds only set it).
const QUOTA_EXCEEDED_CODE = 22;

/**
 * True when `err` is (or wraps) a quota-exceeded failure.
 *
 * Normalises across engines:
 *   - Modern: `DOMException` with `name === 'QuotaExceededError'`.
 *   - Firefox/IndexedDB: `name === 'NS_ERROR_DOM_QUOTA_REACHED'`.
 *   - Legacy WebKit: only `code === 22` is set (no usable `name`).
 *   - Dexie/IDB sometimes surface a wrapped error whose `.inner` /
 *     `.name`/`.message` carries the original — checked defensively.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    inner?: unknown;
  };
  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return true;
  }
  if (e.code === QUOTA_EXCEEDED_CODE) return true;
  // Dexie wraps the underlying DOMException — inspect one level of nesting.
  if (e.inner != null && e.inner !== err && isQuotaExceededError(e.inner)) {
    return true;
  }
  return false;
}
