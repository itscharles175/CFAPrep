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

/**
 * Persist and apply a theme preference. Use this from UI handlers.
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
