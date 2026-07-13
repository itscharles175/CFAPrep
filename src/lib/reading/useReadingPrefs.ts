/**
 * A11Y-1 / UI-2 — React binding for the reading + density preferences.
 *
 * A self-contained hook (no provider required) so any component — the settings
 * panel, the TopBar, a future quick-toggle — can read and mutate the shared
 * preferences and stay in lock-step. Like the theme store (src/lib/theme.ts) the
 * source of truth is `localStorage` + the live DOM attributes; this hook layers a
 * tiny pub/sub on top so multiple mounted consumers (and other browser tabs) all
 * observe the same value.
 *
 * Applying to the DOM is handled here on every change via the engine, so wiring
 * the hook anywhere is enough to keep `<html>` in sync.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_READING_PREFS,
  getStoredReadingPrefs,
  storeReadingPrefs,
  type Density,
  type ReadingPrefs,
} from './readingPrefs';
import { applyReadingPrefs } from './readingEngine';

const STORAGE_KEY = 'qv-reading-prefs';

type Listener = (prefs: ReadingPrefs) => void;
const listeners = new Set<Listener>();
// Module-level cache so a freshly-mounted consumer starts from the latest value
// already chosen this session (not a re-read that could miss an in-flight write).
let current: ReadingPrefs | null = null;

function snapshot(): ReadingPrefs {
  if (current) return current;
  current = getStoredReadingPrefs();
  return current;
}

function publish(next: ReadingPrefs): void {
  current = next;
  storeReadingPrefs(next);
  applyReadingPrefs(next);
  for (const listener of listeners) listener(next);
}

/**
 * Apply the stored reading prefs to the document immediately. Call from app
 * bootstrap (before/at first render) so the first paint already reflects the
 * user's density + reading choices — same flash-avoidance pattern as applyTheme.
 */
export function bootstrapReadingPrefs(): void {
  applyReadingPrefs(snapshot());
}

export interface UseReadingPrefs extends ReadingPrefs {
  /** Replace the whole prefs object. */
  setPrefs(next: ReadingPrefs): void;
  /** Patch one or more fields. */
  update(patch: Partial<ReadingPrefs>): void;
  /** Convenience: set the density axis (UI-2). */
  setDensity(density: Density): void;
  /** Toggle a single boolean reading feature. */
  toggle(key: 'dyslexiaFont' | 'textSpacing' | 'bionicReading' | 'lineFocus'): void;
  /** Reset every preference to the neutral default. */
  reset(): void;
}

export function useReadingPrefs(): UseReadingPrefs {
  const [prefs, setPrefsState] = useState<ReadingPrefs>(() => snapshot());

  useEffect(() => {
    // Subscribe to in-tab changes from other consumers.
    listeners.add(setPrefsState);
    // Cross-tab: another window writing the key updates this one too.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next = getStoredReadingPrefs();
      publish(next); // re-applies + fans out to local listeners
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(setPrefsState);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setPrefs = useCallback((next: ReadingPrefs) => publish(next), []);
  const update = useCallback(
    (patch: Partial<ReadingPrefs>) => publish({ ...snapshot(), ...patch }),
    [],
  );
  const setDensity = useCallback((density: Density) => update({ density }), [update]);
  const toggle = useCallback(
    (key: 'dyslexiaFont' | 'textSpacing' | 'bionicReading' | 'lineFocus') =>
      update({ [key]: !snapshot()[key] } as Partial<ReadingPrefs>),
    [update],
  );
  const reset = useCallback(() => publish({ ...DEFAULT_READING_PREFS }), []);

  return { ...prefs, setPrefs, update, setDensity, toggle, reset };
}
