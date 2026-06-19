/*
 * K4-cmd — host-side LSAT command-palette entries (Phase 1 of Keystone K4).
 *
 * The host ⌘K palette (src/components/Layout/TopBar.tsx) used to surface the
 * whole LSAT plane as ONE "jump to /lsat" row. K4-5 added `lsatSearchRoutes`
 * (the /lsat command vocabulary, already `/lsat`-prefixed) + `routeTree`. This
 * module folds that vocabulary — plus the LSAT palette's own cmdk "Recents" —
 * into first-class host-palette rows, so a single ⌘K serves both planes.
 *
 * NEUTRALITY: this file lives in the HOST tree (src/lib), so — like
 * `src/lib/lsatNavigate.ts` — it must NOT import the vendored LSAT subtree
 * (src/domains/lsat/*). The LSAT routes come from the host's own
 * `routeManifest` re-export; the LSAT "Recents" are read straight from the
 * localStorage key the LSAT recents writer owns (`lsatlab.commandRecents`),
 * matched against `lsatSearchRoutes` rather than via any LSAT import.
 *
 * FLAG GATING: callers gate every row built here behind `LSAT_UNIFIED_SHELL`
 * (default OFF), so the running default palette is byte-for-byte unchanged.
 */

import { lsatAppRoutes, lsatSearchRoutes, type SearchRoute } from '../routes/routeManifest';
import { LSAT_ROUTE_PREFIX, toLsatPath } from './lsatNavigate';

/**
 * The palette row shape (a structural subset of TopBar's local
 * `SearchResultItem`). `external: true` makes the host palette soft-navigate
 * cross-domain via `navigateDomain` (the host client router has no /lsat route).
 */
export interface LsatPaletteEntry {
  id: string;
  title: string;
  subtitle?: string;
  type: string;
  path: string;
  keywords: string[];
  external: true;
}

/** The on-disk key the LSAT command-recents writer (commandRecents.ts) uses. */
const LSAT_COMMAND_RECENTS_KEY = 'lsatlab.commandRecents';
/** Cap recents rows so they never crowd out routes (mirrors the LSAT palette). */
const MAX_LSAT_RECENTS = 5;

/** `lsatSearchRoutes` keyed by their `/lsat`-prefixed path, for fast lookup. */
const lsatRouteByPath = new Map<string, SearchRoute>(
  lsatSearchRoutes.map((route) => [route.path, route]),
);

/**
 * The LSAT route vocabulary as host-palette rows. Marked `external` so they
 * soft-navigate into the LSAT plane. When `testMode` is true, routes the LSAT
 * manifest hides in Test Mode are dropped — honoring `hideInTest` exactly as the
 * legacy LSAT shell does. (`lsatSearchRoutes` already excludes aliases + the
 * dynamic/full-bleed routes, so this mirrors the LSAT palette's "Navigate" set.)
 */
export function lsatRouteEntries(options: { testMode?: boolean } = {}): LsatPaletteEntry[] {
  const { testMode = false } = options;
  return lsatSearchRoutes
    .filter((route) => !(testMode && hidesInTest(route)))
    .map((route) => ({
      id: route.id,
      title: route.title,
      subtitle: route.subtitle,
      type: 'LSAT',
      path: route.path,
      keywords: route.keywords,
      external: true as const,
    }));
}

/**
 * The LSAT palette's cmdk "Recents", folded into the host palette. Reads the
 * shared `lsatlab.commandRecents` localStorage array (app-relative LSAT paths),
 * prefixes each to its host `/lsat` path, and resolves it against
 * `lsatSearchRoutes` for a friendly label. Recents that don't map to a known
 * navigable LSAT route (dynamic/full-bleed paths, aliases) are skipped. In Test
 * Mode, `hideInTest` recents are dropped too. Fully degrading: blocked / empty
 * storage yields no rows.
 */
export function lsatRecentEntries(options: { testMode?: boolean } = {}): LsatPaletteEntry[] {
  const { testMode = false } = options;
  const paths = readLsatRecentPaths();
  const seen = new Set<string>();
  const rows: LsatPaletteEntry[] = [];
  for (const appPath of paths) {
    const hostPath = toLsatPath(appPath);
    if (seen.has(hostPath)) continue;
    seen.add(hostPath);
    const route = lsatRouteByPath.get(hostPath);
    if (!route) continue; // unknown/dynamic LSAT path — no friendly command row
    if (testMode && hidesInTest(route)) continue;
    rows.push({
      id: `lsat-recent:${route.id}`,
      title: route.title,
      subtitle: 'Recent',
      type: 'Recent',
      path: route.path,
      keywords: route.keywords,
      external: true as const,
    });
    if (rows.length >= MAX_LSAT_RECENTS) break;
  }
  return rows;
}

/**
 * A route "hides in test" if the LSAT manifest marked it `hideInTest`. We don't
 * import the LSAT manifest here; `lsatSearchRoutes` doesn't carry the flag, so we
 * recover it from the canonical merged tree's keyword/metadata via the host
 * `routeManifest` re-export instead.
 */
function hidesInTest(route: SearchRoute): boolean {
  return lsatHideInTestPaths.has(route.path);
}

// The /lsat host paths whose LSAT manifest entry is `hideInTest`. Derived once
// from the merged `lsatAppRoutes` (host re-export) so this stays in lockstep
// with the manifest without importing the LSAT subtree.
const lsatHideInTestPaths = new Set<string>(
  lsatAppRoutes.filter((route) => route.hideInTest).map((route) => route.path),
);

/** Read + sanitize the LSAT command-recents array from localStorage. */
function readLsatRecentPaths(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LSAT_COMMAND_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    // Private-mode / blocked storage / malformed JSON — no recents.
    return [];
  }
}

export { LSAT_ROUTE_PREFIX };
