// UX-1 — Cross-domain scroll restoration for the host (CFA/Quant/Excel) shell.
//
// Ported from the LSAT domain's `src/domains/lsat/lib/scrollRestore.ts`, which
// keeps per-route scroll positions in sessionStorage so navigating away and
// back lands the user where they left off. The host needs the same affordance
// for a subtler reason captured in the Wave-5 roadmap (UX-1):
//
//   StudyVault soft-swaps domains via the History API (lib/domainNav's
//   `navigateDomain` → `pushState` + DOMAIN_NAV_EVENT). Under the K4-13 unified
//   shell there is ONE persistent host <BrowserRouter> (see UnifiedRoot); the
//   cross-domain hop swaps which plane the top-level <Routes> renders (it does
//   NOT unmount a sub-app), and UnifiedRoot's CrossDomainNavBridge re-syncs the
//   router to the pushed URL. Because that hop never round-trips through the
//   browser's native back/forward, the browser's own scroll restoration never
//   fires — so returning from /lsat to /today (or the dashboard) snaps to the top
//   of the re-rendered tree, losing the user's place. Persisting the position
//   ourselves and restoring it on mount closes that gap.
//
// Two differences from the LSAT port, both dictated by the host's layout:
//   - The host scrolls the DOCUMENT (`.main-content` has `min-height: 100vh`
//     and no inner overflow), whereas the LSAT shell scrolls an inner <main>.
//     So we read/write `window.scrollY` / `window.scrollTo`, not an element's
//     `scrollTop`.
//   - Keys are namespaced under `studyvault.scroll.` so these entries stay
//     distinct from the LSAT domain's `lsatlab.scroll.` keys in the shared
//     sessionStorage.
//
// Reduced-motion friendly: restoration is an instant jump (`behavior: 'auto'`),
// never a smooth animated scroll, so it respects users who asked the OS to
// reduce motion and avoids a distracting glide on every return.

import { useEffect, useRef } from 'react';

const PREFIX = 'studyvault.scroll.';

function session(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.sessionStorage;
  } catch {
    // Accessing sessionStorage can throw in sandboxed iframes / private mode.
    return undefined;
  }
}

/** Build the sessionStorage key for a route. Defensive against an empty path. */
function keyFor(path: string): string {
  return PREFIX + (path || '/');
}

/** Persist the current vertical scroll offset for `path`. Best-effort: storage
 *  failures (quota, private mode, no DOM) are swallowed. */
export function saveScroll(path: string, y: number): void {
  const store = session();
  if (!store) return;
  try {
    // Clamp to a non-negative integer — overscroll bounce can briefly report a
    // negative `scrollY`, and fractional values add no value here.
    store.setItem(keyFor(path), String(Math.max(0, Math.round(y))));
  } catch {
    /* best-effort */
  }
}

/** Read the saved vertical scroll offset for `path`, or 0 when none/unavailable. */
export function restoreScroll(path: string): number {
  const store = session();
  if (!store) return 0;
  try {
    const raw = store.getItem(keyFor(path));
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Read the window's current vertical scroll offset, SSR/jsdom-safe. */
function currentScrollY(): number {
  if (typeof window === 'undefined') return 0;
  // `scrollY` is the modern accessor; `pageYOffset` is the legacy alias kept for
  // engines that predate it. jsdom defines both (as 0), so this never throws.
  return window.scrollY ?? window.pageYOffset ?? 0;
}

/** Imperatively jump the window to `y` (never smooth — see the module note). */
function scrollWindowTo(y: number): void {
  if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
  try {
    window.scrollTo({ top: y, left: 0, behavior: 'auto' });
  } catch {
    // Some engines reject the options object; fall back to the positional form.
    try {
      window.scrollTo(0, y);
    } catch {
      /* give up silently */
    }
  }
}

export interface UseScrollRestorationOptions {
  /** When false, the hook neither restores nor tracks scrolling. Pages gate
   *  restore on "content is ready" so we don't try to restore to an offset
   *  taller than the not-yet-rendered page (which the browser would clamp back
   *  to the top). Defaults to true. */
  ready?: boolean;
}

/**
 * Save + restore the document scroll position for a route, keyed by `path`.
 *
 * Pages call this with a stable key (e.g. `'host:/today'`) so the position
 * survives both a cross-domain soft-hop and a within-host route change. Once
 * `ready` is true the hook:
 *   - restores the saved offset on the next animation frame (after the page's
 *     deterministic skeletons have reserved their height, so the target offset
 *     is reachable and the browser won't clamp it to the top), and
 *   - tracks subsequent scrolling, persisting the latest offset (rAF-throttled)
 *     plus a final flush on unmount so the most recent position is the one we
 *     return to.
 *
 * Implemented imperatively rather than via React Router's `ScrollRestoration`
 * because the cross-domain hop is driven by `navigateDomain`'s pushState, which
 * the router only observes indirectly (via UnifiedRoot's CrossDomainNavBridge),
 * so RR's own scroll-restoration timing isn't a reliable anchor for it.
 */
export function useScrollRestoration(path: string, { ready = true }: UseScrollRestorationOptions = {}): void {
  // The latest path/ready in a ref so the unmount-flush below can read them
  // without re-subscribing the listener on every change.
  const pathRef = useRef(path);
  pathRef.current = path;

  // Restore once the content is ready (and on path change). A single rAF lets
  // the just-mounted / just-swapped tree lay out its reserved-height skeletons
  // before we jump, so the saved offset is within the scrollable range.
  useEffect(() => {
    if (!ready) return undefined;
    const target = restoreScroll(path);
    let frame = 0;
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => scrollWindowTo(target));
    } else {
      scrollWindowTo(target);
    }
    return () => {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }, [path, ready]);

  // Track scrolling while ready and persist the latest offset, rAF-throttled so
  // a scroll burst writes sessionStorage at most once per frame. A final flush
  // on cleanup captures the position right before a route change / unmount —
  // the moment a cross-domain hop tears the tree down.
  useEffect(() => {
    if (!ready || typeof window === 'undefined') return undefined;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        saveScroll(pathRef.current, currentScrollY());
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      // Final flush so the offset we return to is the last one the user saw.
      saveScroll(pathRef.current, currentScrollY());
    };
  }, [path, ready]);
}
