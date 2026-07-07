/*
 * Cross-domain navigation + CSS isolation for the unified StudyVault root
 * (Plan S6).
 *
 * StudyVault is two apps in one window: the CFA/Quant/Excel host and the
 * vendored LSAT domain, each with its own router + design system. They used to
 * live in separate page loads (a hard `window.location` switch) precisely
 * because their stylesheets conflict in one document — the LSAT Tailwind layer
 * defines `body { background/color }` against its own HSL tokens, which clobber
 * the host's dark palette (verified: host bg flips light when LSAT CSS is
 * present).
 *
 * K4-13 NOTE: the legacy split-shell + its CSS style-isolation observer
 * (startStyleIsolation) were removed in the final cutover — under the unified
 * shell both design systems coexist in one document (the K4 reskin reconciles
 * them). What remains here is the cross-domain navigation surface still used by
 * the unified shell:
 *
 *   - setActiveDomain(d) flips `disabled` on any stylesheet still tagged with
 *     `data-sv-domain` so sheets attributed to the other domain go inert. (No
 *     observer tags new sheets anymore; this is now a no-op unless some sheet
 *     carries the attribute, but navigateDomain still calls it defensively.)
 *
 * navigateDomain() performs the actual cross-domain hop via the History API and
 * notifies the root to re-render.
 */

import { pushHistory } from './navigationHistory';
import { domainForPath, isLsatPath, type Domain } from './domainPath';

export { domainForPath, isLsatPath };
export type { Domain };
export const DOMAIN_NAV_EVENT = 'studyvault:navigate';
const SHEET_ATTR = 'data-sv-domain';

/*
 * UX-5 — route-metadata hints shared by the host chrome.
 *
 * `crossDomainHop(from, to)` answers "does navigating from `from` to `to` cross
 * the host<->LSAT boundary?" — a cross-domain hop swaps which whole sub-app is
 * mounted (a heavier transition that warrants the route-progress bar), whereas
 * an in-plane hop is just the host router swapping a lazy page. The host's
 * route-transition indicator (src/App.jsx) reads this so the progress bar's
 * acknowledgment can be tuned per hop kind.
 *
 * `deepLinkParamsFor(path)` declares which URL search-params a host route treats
 * as deep-link controls (so the chrome can preserve/whitelist them when it
 * synthesizes links). Today only the Review Inbox opts in; the map is the single
 * source of truth so ReviewInbox.jsx and any future linker stay in sync.
 */
export function crossDomainHop(from: string, to: string): boolean {
  return domainForPath(from) !== domainForPath(to);
}

/** Host routes that accept deep-link search-params, keyed by pathname. */
export const ROUTE_DEEP_LINK_PARAMS: Record<string, readonly string[]> = {
  '/review': ['filter', 'item', 'tab'],
};

/** The deep-link search-param names a host route understands (empty if none). */
export function deepLinkParamsFor(pathname: string): readonly string[] {
  return ROUTE_DEEP_LINK_PARAMS[pathname] ?? [];
}

/** Make `domain` the only live design system: enable its sheets, disable the
 *  other domain's. Called on every cross-domain hop (defensive — no observer
 *  tags sheets under the unified shell, so this only affects any sheet still
 *  carrying the `data-sv-domain` attribute). */
export function setActiveDomain(domain: Domain): void {
  if (typeof document === 'undefined') return;
  document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(`[${SHEET_ATTR}]`).forEach((el) => {
    el.disabled = el.getAttribute(SHEET_ATTR) !== domain;
  });
}

/** Soft cross-domain hop: update the URL via History and tell the root to swap.
 *  Within-domain links keep using each app's own router.
 *
 *  UX-4: records the destination on the shared navigation trail so the unified
 *  Back button can hop back across the domain boundary. The label is best-effort
 *  here (the path, unless the caller passes a friendlier one); the destination
 *  plane's route effect then refines it via `pushHistory` (same-path de-dupe
 *  updates the label in place). */
export function navigateDomain(to: string, label?: string): void {
  if (typeof window === 'undefined') return;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === to) return;
  // Pre-flip CSS so the destination paints with the right design system.
  setActiveDomain(domainForPath(to));
  window.history.pushState({}, '', to);
  // Record BEFORE the swap so the trail head matches the new URL the instant
  // the root re-renders (the chrome reads `peekPrevious` for the Back target).
  pushHistory({ path: to, label: label ?? to });
  window.dispatchEvent(new Event(DOMAIN_NAV_EVENT));
}
