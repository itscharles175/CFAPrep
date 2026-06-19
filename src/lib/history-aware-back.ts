/*
 * UX-4 — the back resolver.
 *
 * "Back" in a two-router window is ambiguous: the previous location might live
 * in the SAME plane (the active router can handle it) or the OTHER plane (only
 * a cross-domain soft-hop can reach it). This module reads the shared
 * navigation trail (lib/navigationHistory) and resolves which kind of back the
 * current location wants, so the host TopBar and the LSAT shell can share one
 * "Back" button with identical semantics.
 *
 * It is deliberately side-effect-light: `resolveBack` is a PURE description of
 * what should happen (so it's trivially unit-testable and so each shell can
 * supply its own same-domain navigator), and `performBack` is the thin
 * imperative wrapper the buttons call.
 */

import { domainForPath, navigateDomain, type Domain } from './domainNav';
import { peekPrevious, popHistory, type NavHistoryEntry } from './navigationHistory';

export interface BackTarget {
  /** Where a back press lands. */
  path: string;
  domain: Domain;
  /** Friendly name for the button's aria-label ("Back to <label>"). */
  label: string;
  /**
   * `cross-domain` → the destination is in the other plane; use
   * navigateDomain (a soft swap of the mounted sub-app).
   * `same-domain` → the active router owns it; use the router's own back.
   */
  kind: 'cross-domain' | 'same-domain';
}

export interface BackResolution {
  /** True when there is somewhere to go back to (the button is enabled). */
  canGoBack: boolean;
  /** The resolved destination, or null at the root of the trail. */
  target: BackTarget | null;
}

/**
 * Decide what a "Back" press should do from the current path + the shared
 * trail. Pure: no navigation, no storage mutation.
 *
 * The previous trail entry is the destination. If its domain differs from the
 * CURRENT path's domain, only a cross-domain hop can reach it; otherwise the
 * active router can handle it in-plane.
 */
export function resolveBack(currentPath: string): BackResolution {
  const previous: NavHistoryEntry | null = peekPrevious();
  if (!previous) return { canGoBack: false, target: null };
  const currentDomain = domainForPath(currentPath);
  const kind = previous.domain !== currentDomain ? 'cross-domain' : 'same-domain';
  return {
    canGoBack: true,
    target: {
      path: previous.path,
      domain: previous.domain,
      label: previous.label,
      kind,
    },
  };
}

/**
 * Execute the back navigation resolved for `currentPath`.
 *
 * @param currentPath        the location we're leaving.
 * @param sameDomainBack     the active router's back (host: `() => navigate(-1)`;
 *                           LSAT: its own `navigate(-1)`). Falls back to
 *                           `window.history.back()` when not supplied.
 * @returns the target it navigated to, or null when there was nowhere to go.
 */
export function performBack(
  currentPath: string,
  sameDomainBack?: () => void,
): BackTarget | null {
  const { canGoBack, target } = resolveBack(currentPath);
  if (!canGoBack || !target) return null;

  // Drop the current location off the trail so the head tracks where we land —
  // popstate-driven re-pushes are de-duped, so this stays consistent whether the
  // back is in-plane (router popstate) or cross-domain (navigateDomain pushState).
  popHistory();

  if (target.kind === 'cross-domain') {
    navigateDomain(target.path);
  } else if (sameDomainBack) {
    sameDomainBack();
  } else if (typeof window !== 'undefined') {
    window.history.back();
  }
  return target;
}
