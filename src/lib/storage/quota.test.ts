import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRESSURE_CRITICAL_THRESHOLD,
  PRESSURE_WARN_THRESHOLD,
  estimateStoragePressure,
  isPersisted,
  isQuotaExceededError,
  requestPersistentStorage,
} from './quota';

// ===========================================================================
// GAP-QUOTA-1 — IndexedDB durability against eviction + quota pressure
// ===========================================================================
//
// Fully OFFLINE: there is no live Storage API in the test runner, so each test
// installs a fake `navigator.storage` (or deletes it to exercise the absence
// guards) and restores the original descriptor afterward. No sidecar/LLM.

// ---------------------------------------------------------------------------
// navigator.storage harness
// ---------------------------------------------------------------------------
const realStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');

/** Install a partial StorageManager mock onto navigator.storage. */
function installStorage(mock: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, 'storage', {
    value: mock,
    configurable: true,
    writable: true,
  });
}

/** Remove navigator.storage entirely (simulates an old WebView / SSR). */
function removeStorage(): void {
  Object.defineProperty(navigator, 'storage', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  // Restore the runtime's original navigator.storage so tests don't leak.
  if (realStorageDescriptor) {
    Object.defineProperty(navigator, 'storage', realStorageDescriptor);
  } else {
    // It didn't exist originally — delete what we added.
    delete (navigator as { storage?: unknown }).storage;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// requestPersistentStorage()
// ---------------------------------------------------------------------------
describe('requestPersistentStorage', () => {
  it("returns 'persisted' when persist() grants", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    installStorage({ persist, persisted });
    await expect(requestPersistentStorage()).resolves.toBe('persisted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("returns 'denied' when persist() resolves false", async () => {
    installStorage({
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    });
    await expect(requestPersistentStorage()).resolves.toBe('denied');
  });

  it("returns 'unsupported' when navigator.storage is absent", async () => {
    removeStorage();
    await expect(requestPersistentStorage()).resolves.toBe('unsupported');
  });

  it("returns 'unsupported' when persist() is not a function", async () => {
    installStorage({ persisted: vi.fn().mockResolvedValue(false) });
    await expect(requestPersistentStorage()).resolves.toBe('unsupported');
  });

  it("returns 'unsupported' when persist() throws", async () => {
    installStorage({
      persist: vi.fn().mockRejectedValue(new Error('boom')),
      persisted: vi.fn().mockResolvedValue(false),
    });
    await expect(requestPersistentStorage()).resolves.toBe('unsupported');
  });

  it('short-circuits without calling persist() when already persisted (idempotent)', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(true);
    installStorage({ persist, persisted });
    await expect(requestPersistentStorage()).resolves.toBe('persisted');
    expect(persist).not.toHaveBeenCalled();
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it('falls through to persist() when persisted() throws', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockRejectedValue(new Error('nope'));
    installStorage({ persist, persisted });
    await expect(requestPersistentStorage()).resolves.toBe('persisted');
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// isPersisted()
// ---------------------------------------------------------------------------
describe('isPersisted', () => {
  it('reflects persisted() truthiness', async () => {
    installStorage({ persisted: vi.fn().mockResolvedValue(true) });
    await expect(isPersisted()).resolves.toBe(true);
  });

  it('returns false when persisted() resolves false', async () => {
    installStorage({ persisted: vi.fn().mockResolvedValue(false) });
    await expect(isPersisted()).resolves.toBe(false);
  });

  it('returns false when navigator.storage is absent', async () => {
    removeStorage();
    await expect(isPersisted()).resolves.toBe(false);
  });

  it('returns false when persisted() throws', async () => {
    installStorage({ persisted: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(isPersisted()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// estimateStoragePressure()
// ---------------------------------------------------------------------------
describe('estimateStoragePressure', () => {
  function withEstimate(usage: number | undefined, quota: number | undefined): void {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage, quota } as StorageEstimate),
    });
  }

  it("classifies low usage as 'ok'", async () => {
    withEstimate(100, 1000); // 10%
    const p = await estimateStoragePressure();
    expect(p).toMatchObject({ usageBytes: 100, quotaBytes: 1000, level: 'ok' });
    expect(p.pct).toBeCloseTo(0.1, 5);
  });

  it("classifies usage at the warn threshold as 'warn'", async () => {
    withEstimate(PRESSURE_WARN_THRESHOLD * 1000, 1000); // exactly 80%
    const p = await estimateStoragePressure();
    expect(p.level).toBe('warn');
    expect(p.pct).toBeCloseTo(PRESSURE_WARN_THRESHOLD, 5);
  });

  it("classifies just below the warn threshold as 'ok'", async () => {
    withEstimate(799, 1000); // 79.9%
    const p = await estimateStoragePressure();
    expect(p.level).toBe('ok');
  });

  it("classifies usage at the critical threshold as 'critical'", async () => {
    withEstimate(PRESSURE_CRITICAL_THRESHOLD * 1000, 1000); // exactly 95%
    const p = await estimateStoragePressure();
    expect(p.level).toBe('critical');
  });

  it("classifies just below critical as 'warn'", async () => {
    withEstimate(949, 1000); // 94.9%
    const p = await estimateStoragePressure();
    expect(p.level).toBe('warn');
  });

  it("returns 'unknown' when navigator.storage is absent", async () => {
    removeStorage();
    const p = await estimateStoragePressure();
    expect(p).toEqual({ usageBytes: null, quotaBytes: null, pct: null, level: 'unknown' });
  });

  it("returns 'unknown' when estimate() is not a function", async () => {
    installStorage({});
    const p = await estimateStoragePressure();
    expect(p.level).toBe('unknown');
  });

  it("returns 'unknown' when estimate() throws", async () => {
    installStorage({ estimate: vi.fn().mockRejectedValue(new Error('boom')) });
    const p = await estimateStoragePressure();
    expect(p.level).toBe('unknown');
  });

  it("returns 'unknown' (null pct) when quota is zero", async () => {
    withEstimate(10, 0);
    const p = await estimateStoragePressure();
    expect(p.usageBytes).toBe(10);
    expect(p.quotaBytes).toBe(0);
    expect(p.pct).toBeNull();
    expect(p.level).toBe('unknown');
  });

  it("returns 'unknown' pct when estimate fields are missing", async () => {
    withEstimate(undefined, undefined);
    const p = await estimateStoragePressure();
    expect(p.usageBytes).toBeNull();
    expect(p.quotaBytes).toBeNull();
    expect(p.level).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// isQuotaExceededError()
// ---------------------------------------------------------------------------
describe('isQuotaExceededError', () => {
  it('matches a DOMException named QuotaExceededError', () => {
    const err = new DOMException('full', 'QuotaExceededError');
    expect(isQuotaExceededError(err)).toBe(true);
  });

  it('matches a plain object with name QuotaExceededError', () => {
    expect(isQuotaExceededError({ name: 'QuotaExceededError' })).toBe(true);
  });

  it('matches the Firefox NS_ERROR_DOM_QUOTA_REACHED name', () => {
    expect(isQuotaExceededError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
  });

  it('matches legacy code 22 with no usable name', () => {
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
  });

  it('matches a Dexie-style wrapped error via .inner', () => {
    const wrapped = {
      name: 'AbortError',
      message: 'transaction aborted',
      inner: { name: 'QuotaExceededError' },
    };
    expect(isQuotaExceededError(wrapped)).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isQuotaExceededError(new Error('something else'))).toBe(false);
    expect(isQuotaExceededError({ name: 'TypeError', code: 18 })).toBe(false);
  });

  it('does not match null / undefined / primitives', () => {
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false);
    expect(isQuotaExceededError(22)).toBe(false);
  });

  it('does not infinite-loop on a self-referential inner', () => {
    const self: { name: string; inner?: unknown } = { name: 'AbortError' };
    self.inner = self;
    expect(isQuotaExceededError(self)).toBe(false);
  });
});
