/**
 * UI-3 — reading themes (a token-override axis layered over the base palette).
 *
 * The host already has a base `data-theme` (light | dark | system) owned by
 * src/lib/theme.ts + the TopBar switcher. Reading themes are a SEPARATE, additive
 * axis — `data-reading-theme` on <html> — so they compose ON TOP of whatever base
 * palette is active instead of replacing it:
 *
 *   - 'default'        — no override (the base palette shows through).
 *   - 'warm-paper'     — a sepia / low-blue-light reading surface for long sessions.
 *   - 'high-contrast'  — maximal text/background contrast + stronger borders (AAA).
 *
 * Token overrides live in src/index.css under `:root[data-reading-theme="…"]`.
 * Persistence is plain localStorage (NOT the Dexie schema) and is applied at
 * bootstrap so the first paint is correct — same pattern as the theme + reading
 * preference stores.
 */

export type ReadingTheme = 'default' | 'warm-paper' | 'high-contrast';

const STORAGE_KEY = 'qv-reading-theme';
const ATTRIBUTE = 'data-reading-theme';

const VALUES: ReadingTheme[] = ['default', 'warm-paper', 'high-contrast'];

function isReadingTheme(value: unknown): value is ReadingTheme {
  return typeof value === 'string' && (VALUES as string[]).includes(value);
}

/** Read the persisted reading theme; defaults to 'default' (no override). */
export function getStoredReadingTheme(): ReadingTheme {
  if (typeof window === 'undefined') return 'default';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isReadingTheme(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

/**
 * Apply a reading theme to <html>. 'default' REMOVES the attribute so the base
 * palette is untouched; the others stamp `data-reading-theme="…"` for the CSS
 * token overrides to pick up. Pure DOM mutation (no storage write).
 */
export function applyReadingTheme(theme: ReadingTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'default') root.removeAttribute(ATTRIBUTE);
  else root.setAttribute(ATTRIBUTE, theme);
}

type Listener = (theme: ReadingTheme) => void;
const listeners = new Set<Listener>();

/** Subscribe to reading-theme changes (this tab + cross-tab `storage` event). */
export function subscribeReadingTheme(listener: Listener): () => void {
  listeners.add(listener);
  let onStorage: ((event: StorageEvent) => void) | undefined;
  if (typeof window !== 'undefined') {
    onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      listener(isReadingTheme(event.newValue) ? event.newValue : 'default');
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

/** Persist + apply a reading theme, notifying subscribers. Use from UI handlers. */
export function setReadingTheme(theme: ReadingTheme): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private mode / quota — DOM still updated below.
    }
  }
  applyReadingTheme(theme);
  for (const listener of listeners) listener(theme);
}

/** Apply the stored reading theme to the document — call from app bootstrap. */
export function bootstrapReadingTheme(): void {
  applyReadingTheme(getStoredReadingTheme());
}
