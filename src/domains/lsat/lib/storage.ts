// Centralized, typed, namespaced Web Storage access (R7 7.6).
//
// Historically ~25 modules each re-implemented the same try/catch + JSON.parse
// dance against localStorage, with the key strings scattered across files. This
// module is the single place that:
//   - wraps `getItem`/`setItem`/`removeItem` in try/catch (private mode, quota,
//     SSR/no-DOM) so callers never crash on storage failures,
//   - centralizes JSON encode/decode with a typed fallback on parse errors,
//   - offers an optional *versioned* envelope so a store can migrate its shape,
//   - registers the well-known key strings in one `STORAGE_KEYS` map.
//
// IMPORTANT: the literal key STRINGS are part of the on-disk contract. Existing
// users already have data under `lsatlab.*`; never rename a key here or those
// preferences silently reset. New code should reference `STORAGE_KEYS` (or pass
// an explicit string for per-id keys) rather than re-typing the literal.

/** Common namespace prefix for every LSATLab storage key. */
export const NS = "lsatlab.";

/**
 * Registry of fixed (non-parameterized) storage keys. Per-entity keys that are
 * built from an id (e.g. `lsatlab.notes.{questionId}`) are NOT listed here —
 * those modules build the string themselves; the `*_PREFIX` entries document
 * the stable prefixes they use.
 */
export const STORAGE_KEYS = {
  // Test-taking experience (prefs.ts)
  reading: `${NS}reading`,
  rcSplit: `${NS}rcSplit`,
  goal: `${NS}goal`,
  bestScore: `${NS}bestScore`,
  density: `${NS}density`,
  streakFreeze: `${NS}streakFreeze`,
  onboardingDone: `${NS}onboardingDone`,
  highContrast: `${NS}highContrast`,
  examKiosk: `${NS}examKiosk`,
  measureCh: `${NS}measureCh`,
  timerDefaults: `${NS}timerDefaults`,
  accommodations: `${NS}accommodations`,
  weeklyGoals: `${NS}weeklyGoals`,
  analyticsViews: `${NS}analyticsViews`,
  analyticsAlertsDismissed: `${NS}analyticsAlertsDismissed`,
  analyticsThresholds: `${NS}analyticsThresholds`,
  analyticsGapSnapshot: `${NS}analyticsGapSnapshot`,
  navigatorMode: `${NS}navigatorMode`,
  brLastConfidence: `${NS}brLastConfidence`,
  planBudgetMin: `${NS}planBudgetMin`,
  studyNudgeDismissed: `${NS}studyNudgeDismissed`,
  aiPrereqDismissed: `${NS}aiPrereqDismissed`,

  // Single-key feature modules
  aiMetrics: `${NS}aiMetrics`,
  commandRecents: `${NS}commandRecents`,
  srsQueue: `${NS}srsQueue`,
  // NOTE: the former `window: "lsatlab.window"` key (the old JS window-state
  // shim) was retired in W8 — window geometry is now persisted natively by
  // tauri-plugin-window-state. Any stale `lsatlab.window` entry is simply
  // ignored. The key string is intentionally not reused.
  resume: `${NS}resume`,
  recommendationInbox: `${NS}recommendationInbox`,
  drillTimeCapMin: `${NS}drillTimeCapMin`,
  examSounds: `${NS}examSounds`,
  keyboardMap: `${NS}keyboardMap`,
  offlineQueue: `${NS}offlineQueue`,
  quarantineDismissed: `${NS}quarantineDismissed`,
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** Storage areas we use. `local` survives reloads; `session` is per-tab. */
export type StorageArea = "local" | "session";

function area(which: StorageArea): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return which === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    // Accessing the property can throw in some sandboxed iframes.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Raw string access
// ---------------------------------------------------------------------------
export function getRaw(key: string, which: StorageArea = "local"): string | null {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setRaw(key: string, value: string, which: StorageArea = "local"): void {
  try {
    area(which)?.setItem(key, value);
  } catch {
    /* quota / unavailable storage — best-effort */
  }
}

export function remove(key: string, which: StorageArea = "local"): void {
  try {
    area(which)?.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// JSON access — the common case (parse failures fall back to `fallback`)
// ---------------------------------------------------------------------------
export function getJSON<T>(key: string, fallback: T, which: StorageArea = "local"): T {
  const raw = getRaw(key, which);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJSON<T>(key: string, value: T, which: StorageArea = "local"): void {
  try {
    setRaw(key, JSON.stringify(value), which);
  } catch {
    /* serialization failure — best-effort */
  }
}

// ---------------------------------------------------------------------------
// Versioned envelope — for stores whose shape may change incompatibly. The
// payload is wrapped as `{ v, data }`; reads return `fallback` when the version
// does not match (or the value is absent/corrupt), so a bumped version cleanly
// ignores stale data without throwing.
// ---------------------------------------------------------------------------
interface Versioned<T> {
  v: number;
  data: T;
}

export function getVersioned<T>(
  key: string,
  version: number,
  fallback: T,
  which: StorageArea = "local",
): T {
  const raw = getRaw(key, which);
  if (raw == null) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<Versioned<T>>;
    if (parsed == null || typeof parsed !== "object" || parsed.v !== version) {
      return fallback;
    }
    return (parsed.data ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function setVersioned<T>(
  key: string,
  version: number,
  value: T,
  which: StorageArea = "local",
): void {
  setJSON<Versioned<T>>(key, { v: version, data: value }, which);
}
