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
 * To get SOFT navigation (no full reload, no white flash, shared window) while
 * keeping each app's mature router untouched, src/main.jsx mounts ONE React
 * root that swaps which sub-app is rendered, and this module keeps only the
 * ACTIVE domain's CSS live:
 *
 *   - startStyleIsolation() installs a <head> MutationObserver that stamps every
 *     dynamically-injected stylesheet (<link>/<style>) with the domain that was
 *     active when it loaded — so even lazily code-split per-page CSS is
 *     attributed correctly, with no brittle filename matching.
 *   - setActiveDomain(d) flips `disabled` so sheets tagged for the other domain
 *     go inert. Untagged sheets that existed before isolation started stay live
 *     as a shared base.
 *
 * navigateDomain() performs the actual cross-domain hop via the History API and
 * notifies the root to re-render + re-isolate.
 */

export type Domain = 'host' | 'lsat';
export const DOMAIN_NAV_EVENT = 'studyvault:navigate';
const SHEET_ATTR = 'data-sv-domain';

export function isLsatPath(pathname: string): boolean {
  return pathname === '/lsat' || pathname.startsWith('/lsat/');
}

export function domainForPath(pathname: string): Domain {
  return isLsatPath(pathname) ? 'lsat' : 'host';
}

let activeDomain: Domain = 'host';
let observer: MutationObserver | null = null;

function isSheet(node: Node): node is HTMLLinkElement | HTMLStyleElement {
  if (!(node instanceof Element)) return false;
  return (
    node.tagName === 'STYLE' ||
    (node.tagName === 'LINK' && (node as HTMLLinkElement).rel === 'stylesheet')
  );
}

function stamp(node: Node): void {
  if (isSheet(node) && !node.hasAttribute(SHEET_ATTR)) {
    node.setAttribute(SHEET_ATTR, activeDomain);
    // A sheet injected for the inactive domain (rare ordering) starts inert.
    node.disabled = node.getAttribute(SHEET_ATTR) !== activeDomain;
  }
}

/** Begin attributing every injected stylesheet to the active domain. Call once,
 *  before the first sub-app's lazy chunk (and its CSS) loads. */
export function startStyleIsolation(initial: Domain): void {
  if (observer || typeof document === 'undefined') return;
  activeDomain = initial;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach(stamp);
  });
  observer.observe(document.head, { childList: true });
}

/** Make `domain` the only live design system: enable its sheets, disable the
 *  other domain's. Call on every cross-domain swap (and at startup). */
export function setActiveDomain(domain: Domain): void {
  activeDomain = domain;
  if (typeof document === 'undefined') return;
  document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(`[${SHEET_ATTR}]`).forEach((el) => {
    el.disabled = el.getAttribute(SHEET_ATTR) !== domain;
  });
}

/** Soft cross-domain hop: update the URL via History and tell the root to swap.
 *  Within-domain links keep using each app's own router. */
export function navigateDomain(to: string): void {
  if (typeof window === 'undefined') return;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === to) return;
  // Pre-flip CSS so the destination paints with the right design system.
  setActiveDomain(domainForPath(to));
  window.history.pushState({}, '', to);
  window.dispatchEvent(new Event(DOMAIN_NAV_EVENT));
}
