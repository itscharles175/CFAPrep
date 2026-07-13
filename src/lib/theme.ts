/**
 * Theme manager — bootstrap-critical, framework-free.
 *
 * The `data-theme` attribute on `<html>` is the single source of truth for
 * which palette is active. CSS in `src/styles/tokens.css` and `src/index.css`
 * targets that attribute. Because applying the attribute is a one-line DOM
 * mutation, this module deliberately stays outside React: it is invoked from
 * `src/main.jsx` *before* `ReactDOM.createRoot(...).render(...)` so the first
 * paint is already in the correct palette and the user never sees a flash.
 *
 * Three semantic values:
 *   - 'light' / 'dark' — explicit override; sets `data-theme="..."`.
 *   - 'system'         — defer to the OS. The attribute is *removed* so the
 *                        CSS `prefers-color-scheme` media query takes over.
 *
 * Persistence uses `localStorage` directly (not the project's `storage`
 * abstraction) because theme bootstrap must run synchronously, before any
 * IndexedDB / Dexie scaffolding is available.
 */

export type ThemeName = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'qv-theme';
const ATTRIBUTE = 'data-theme';

// UA2 — the legacy LSAT theme key. Before the providers were unified, the
// vendored LSAT domain persisted its base theme separately under this key and
// `src/main.jsx` copied `qv-theme` into it on every cross-domain hop. Both
// domains now read/write the single `qv-theme` key (this module is the one
// source of truth), so the LSAT key is migrated once and then left untouched.
const LEGACY_LSAT_KEY = 'lsatlab-theme';

function isThemeName(value: unknown): value is ThemeName {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Read the persisted theme preference. Defaults to `'system'` so first-time
 * visitors honour their OS setting until they make an explicit choice.
 */
export function getStoredTheme(): ThemeName {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeName(raw) ? raw : 'system';
  } catch {
    // Private-mode browsers and storage quotas can throw — fall back gracefully.
    return 'system';
  }
}

/**
 * Apply a theme to the document root. For 'light' / 'dark' this sets the
 * `data-theme` attribute; for 'system' it REMOVES the attribute so the CSS
 * `@media (prefers-color-scheme: ...)` block decides at render time.
 *
 * Pure DOM mutation, no storage write — pair with `setTheme` if you also need
 * to persist the choice.
 */
export function applyTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute(ATTRIBUTE);
  } else {
    root.setAttribute(ATTRIBUTE, theme);
  }
}

// UA2 — single-source-of-truth subscription layer. The host ThemeContext and
// the vendored LSAT theme-provider are two React trees that never coexist, but
// they share this one module + the `qv-theme` key, so whichever one is mounted
// is always reading the same persisted preference. `subscribe` also lets a
// mounted provider follow `qv-theme` changes from *another* browser tab (the
// native `storage` event), so the desktop app stays consistent across windows.
type ThemeListener = (theme: ThemeName) => void;
const listeners = new Set<ThemeListener>();

function notify(theme: ThemeName): void {
  for (const listener of listeners) listener(theme);
}

/**
 * Subscribe to theme-preference changes (from `setTheme` in this tab, or from
 * another tab via the `storage` event). Returns an unsubscribe function. Both
 * theme providers use this so a toggle in one domain is reflected in the other.
 */
export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  let onStorage: ((event: StorageEvent) => void) | undefined;
  if (typeof window !== 'undefined') {
    onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      listener(isThemeName(event.newValue) ? event.newValue : 'system');
    };
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (onStorage && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

/**
 * Persist and apply a theme preference. Use this from UI handlers. Notifies any
 * subscribers (the other domain's provider) so the two stay in lock-step.
 */
export function setTheme(theme: ThemeName): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures — the in-memory `data-theme` attribute is
      // still applied below so the current session reflects the choice.
    }
  }
  applyTheme(theme);
  notify(theme);
}

/**
 * Resolve the currently *active* palette, taking the OS preference into
 * account when the user has chosen 'system'. Useful for picking icons or
 * labels that depend on what the user is actually looking at.
 */
export function getActiveTheme(theme: ThemeName = getStoredTheme()): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * UA2 one-time migration. Earlier builds wrote the LSAT base theme to its own
 * `lsatlab-theme` key. Now both domains share `qv-theme`, so on first run we
 * fold any legacy value forward (only if the user never made an explicit host
 * choice) and clear the stale key so it can never drift again. Idempotent and
 * safe to call on every boot.
 */
export function migrateLegacyLsatTheme(): void {
  if (typeof window === 'undefined') return;
  try {
    const legacy = window.localStorage.getItem(LEGACY_LSAT_KEY);
    if (legacy === null) return;
    // Only adopt the legacy value if the shared key has no explicit pref yet, so
    // an existing host choice always wins over a stale per-domain one.
    if (window.localStorage.getItem(STORAGE_KEY) === null && isThemeName(legacy)) {
      window.localStorage.setItem(STORAGE_KEY, legacy);
    }
    window.localStorage.removeItem(LEGACY_LSAT_KEY);
  } catch {
    // Private mode / quota — nothing to migrate, the shared key still wins.
  }
}
