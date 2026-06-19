/*
 * UX-4 — unified breadcrumb trail builder.
 *
 * One function (`crumbsForPath`) that, given any full app path, returns the
 * breadcrumb trail for BOTH planes:
 *
 *   - HOST paths (`/`, `/cfa/...`, `/quant/...`, …) reuse the typed host route
 *     manifest's own `breadcrumbs` field — matched with react-router's
 *     `matchPath` so dynamic routes (`/cfa/:level/:topic`) resolve correctly.
 *   - LSAT paths (`/lsat`, `/lsat/...`) build a PARENTS trail mirroring the LSAT
 *     shell's existing `RouteBreadcrumb`, with the same dynamic labels
 *     (`/take/:id`, `/exam/:id`, `/analytics/type/:type`).
 *
 * It lives in host `src/lib` (host-tsc-checked) and therefore must NOT import
 * the vendored LSAT subtree (excluded from host tsc). The LSAT label rules are
 * tiny and pure, so they're re-stated here rather than imported — the LSAT
 * route paths/labels themselves still come from the LSAT manifest, which the
 * host manifest already imports type-safely.
 */

import { matchPath } from 'react-router-dom';
import { appRoutes } from '../routes/routeManifest';
import { routeManifest as lsatRouteManifest } from '../domains/lsat/lib/routeManifest';
import { domainForPath } from './domainNav';

export interface Crumb {
  label: string;
  /** Full app path (incl. `/lsat` prefix for the LSAT plane), or undefined for
   *  the current/last crumb which is not a link. */
  to?: string;
}

const LSAT_PREFIX = '/lsat';

// LSAT manifest label lookup (canonical-aware, mirrors routeManifest helpers).
const lsatLabels = new Map(lsatRouteManifest.map((e) => [e.path, e.label]));
function lsatCanonical(path: string): string {
  return lsatRouteManifest.find((e) => e.path === path)?.canonicalPath ?? path;
}

/**
 * The LSAT shell's `routeCommandLabel` rules, re-stated (the original lives in
 * the vendored subtree). App-relative path in, friendly label out.
 */
function lsatRouteLabel(appRelative: string): string {
  const fromManifest = lsatLabels.get(lsatCanonical(appRelative));
  if (fromManifest) return fromManifest;
  if (appRelative === '/review/history') return 'Session history';
  if (appRelative.startsWith('/analytics/type/')) return 'Type analytics';
  if (appRelative.startsWith('/take/')) return 'Timed section';
  if (appRelative.startsWith('/exam/')) return 'Full exam';
  return appRelative;
}

/** Parent-nesting rules for deeper LSAT screens (mirror of breadcrumb.tsx). */
const LSAT_PARENTS: { match: (p: string) => boolean; to: string; label: string }[] = [
  { match: (p) => p.startsWith('/review/history'), to: '/review', label: 'Review' },
  { match: (p) => p.startsWith('/analytics/'), to: '/analytics', label: 'Analytics' },
  { match: (p) => p.startsWith('/bank/'), to: '/bank', label: 'Bank' },
];

function lsatCrumbs(fullPath: string): Crumb[] {
  // Strip the host-served `/lsat` prefix to get the app-relative LSAT path.
  const appRelative = fullPath === LSAT_PREFIX ? '/' : fullPath.slice(LSAT_PREFIX.length) || '/';
  // Root of the LSAT plane — the shell shows no trail there.
  if (appRelative === '/' || appRelative === '') {
    return [{ label: 'LSAT Lab' }];
  }
  const trail: Crumb[] = [{ label: 'LSAT Lab', to: LSAT_PREFIX }];
  const parent = LSAT_PARENTS.find((p) => p.match(appRelative));
  if (parent && parent.to !== appRelative) {
    trail.push({ label: parent.label, to: `${LSAT_PREFIX}${parent.to}` });
  }
  trail.push({ label: lsatRouteLabel(appRelative) });
  return trail;
}

function hostCrumbs(fullPath: string): Crumb[] {
  // Find the host manifest route whose (possibly dynamic) path matches.
  const matched = appRoutes.find((route) => matchPath({ path: route.path, end: true }, fullPath));
  if (!matched) {
    // Unknown host route (e.g. /leeches or a 404) — degrade to a Dashboard root
    // so the chrome still anchors the user.
    return fullPath === '/' ? [{ label: 'Dashboard' }] : [{ label: 'Dashboard', to: '/' }, { label: 'This page' }];
  }
  // The manifest's breadcrumbs are {label, path}: the last one is the current
  // page (rendered as aria-current, no link).
  return matched.breadcrumbs.map((crumb, index, all) => ({
    label: crumb.label,
    to: index < all.length - 1 ? crumb.path : undefined,
  }));
}

/**
 * Breadcrumb trail for any full app path. The last crumb is the current page
 * (no `to`); earlier crumbs link to their destination. Returns a single
 * label-only crumb at a plane's root (the bar renders nothing in that case).
 */
export function crumbsForPath(fullPath: string): Crumb[] {
  return domainForPath(fullPath) === 'lsat' ? lsatCrumbs(fullPath) : hostCrumbs(fullPath);
}

/** Friendly label for a path — used to title navigation-history entries. */
export function labelForPath(fullPath: string): string {
  const crumbs = crumbsForPath(fullPath);
  return crumbs.length ? crumbs[crumbs.length - 1].label : fullPath;
}
