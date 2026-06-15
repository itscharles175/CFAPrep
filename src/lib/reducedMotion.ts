/**
 * UC6 — `prefers-reduced-motion` awareness.
 *
 * The global stylesheet (src/index.css) already neutralises animations and
 * transitions under `@media (prefers-reduced-motion: reduce)`. This module is
 * the JS counterpart: components that drive motion imperatively (confetti,
 * spring-animated counters, auto-scroll) can read the user's preference and skip
 * the effect, instead of fighting CSS that has already been damped.
 *
 * Everything is matchMedia-based, SSR/jsdom-safe (returns `false` when the API
 * is unavailable), and the hook stays subscribed so a mid-session OS change is
 * reflected immediately.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Returns true when the user has asked the OS to reduce motion. Safe to call in
 * any environment: when `matchMedia` is unavailable (jsdom default, SSR) it
 * returns false so callers fall back to the full-motion path.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

/**
 * React hook mirroring `prefersReducedMotion()` that re-renders when the OS
 * preference changes mid-session. Uses the modern `addEventListener('change')`
 * API with a fallback to the legacy `addListener` for older engines.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotion());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Sync once on mount in case the preference changed before the listener
    // attached.
    setReduced(mql.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Legacy Safari (< 14) / older engines.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return reduced;
}
