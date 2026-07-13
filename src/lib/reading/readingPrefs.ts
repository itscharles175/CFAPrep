/**
 * A11Y-1 / UI-2 — inclusive-reading + density preferences (pure data layer).
 *
 * This module is the single source of truth for the *values* the reading engine
 * and density axis apply to the document. It is deliberately framework-free and
 * persistence is plain `localStorage` (NOT the Dexie schema) because — like the
 * theme bootstrap (src/lib/theme.ts) — these preferences must be readable
 * synchronously before React (and before any IndexedDB scaffolding) is ready, so
 * the very first paint already reflects the user's choice with no flash.
 *
 * The DOM application (writing CSS variables + data-attributes onto <html>) lives
 * in `readingEngine.ts`; this file only reads/writes/validates the stored shape.
 */

/** Density axis (UI-2). Mirrors the LSAT domain's `Density` vocabulary. */
export type Density = 'comfortable' | 'compact';

/**
 * Inclusive-reading preferences (A11Y-1). Every field defaults to "off"/neutral
 * so the engine is a pure no-op until the user opts in.
 */
export interface ReadingPrefs {
  /** Density axis driving [data-density] on <html> + the spacing token deltas. */
  density: Density;
  /** OpenDyslexic-style font stack on body copy (falls back to the system UI font). */
  dyslexiaFont: boolean;
  /**
   * WCAG 1.4.12 text-spacing. When on, line-height / letter / word / paragraph
   * spacing are bumped to the SC's minimums (and content must not clip — the
   * tokens below are chosen to meet, not exceed wildly, the criterion).
   */
  textSpacing: boolean;
  /** Bionic-reading emphasis (bold the leading fixation of each word). */
  bionicReading: boolean;
  /** Line-focus ruler that follows the pointer/caret to anchor the reading line. */
  lineFocus: boolean;
}

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  density: 'comfortable',
  dyslexiaFont: false,
  textSpacing: false,
  bionicReading: false,
  lineFocus: false,
};

const STORAGE_KEY = 'qv-reading-prefs';

function isDensity(value: unknown): value is Density {
  return value === 'comfortable' || value === 'compact';
}

/**
 * Coerce an unknown (parsed-JSON) value into a complete, valid `ReadingPrefs`,
 * filling any missing/invalid field from the defaults. Tolerant by design so a
 * partial or older-shape stored blob still loads cleanly.
 */
export function normalizeReadingPrefs(value: unknown): ReadingPrefs {
  const raw = (value ?? {}) as Partial<Record<keyof ReadingPrefs, unknown>>;
  return {
    density: isDensity(raw.density) ? raw.density : DEFAULT_READING_PREFS.density,
    dyslexiaFont: typeof raw.dyslexiaFont === 'boolean' ? raw.dyslexiaFont : false,
    textSpacing: typeof raw.textSpacing === 'boolean' ? raw.textSpacing : false,
    bionicReading: typeof raw.bionicReading === 'boolean' ? raw.bionicReading : false,
    lineFocus: typeof raw.lineFocus === 'boolean' ? raw.lineFocus : false,
  };
}

/** Read the persisted reading preferences, defaulting cleanly on any failure. */
export function getStoredReadingPrefs(): ReadingPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_READING_PREFS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_READING_PREFS };
    return normalizeReadingPrefs(JSON.parse(raw));
  } catch {
    // Private mode, quota, or malformed JSON — fall back to defaults.
    return { ...DEFAULT_READING_PREFS };
  }
}

/** Persist the reading preferences. Swallows storage failures (private mode). */
export function storeReadingPrefs(prefs: ReadingPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore — the in-memory + DOM application still reflects the choice.
  }
}
