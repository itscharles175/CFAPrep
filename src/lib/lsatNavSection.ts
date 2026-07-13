/*
 * K4-6 — shared builder for the unified host shell's LSAT navigation section.
 *
 * Both the host Sidebar (flag-gated 4th section) and <SharedLayout> render the
 * vendored LSAT surface as one collapsible section grouped by `navGroup`. This
 * module is the SINGLE source of that grouping so the two consumers can't drift,
 * and so the K4-5 `lsatAppRoutes` stays the source of truth for paths/labels.
 *
 * It lives in host `src/lib` (host-tsc-checked) and imports ONLY the typed host
 * route manifest — never the vendored LSAT subtree (excluded from host tsc).
 *
 * Curation (mirrors the LSAT shell's own nav rail):
 *   - Aliases (`canonicalPath` set, e.g. `/lsat/notebook`) are dropped — only
 *     their canonical target appears.
 *   - Dynamic / full-bleed routes (take/exam/blind-review/popout/analytics-detail
 *     /explanation/tag-review) have NO `commandLabel`; they're navigation
 *     targets, not nav rows, so they're excluded.
 *   - In Test Mode, `hideInTest` routes are omitted (the LSAT shell hides them),
 *     matching the manifest's `appMode` ('study' for hideInTest, else 'both').
 */

import { lsatAppRoutes } from '../routes/routeManifest';
import type { AppRoute } from '../routes/routeManifest';

export type LsatNavMode = 'study' | 'test';

/** One nav row in the LSAT section. */
export interface LsatNavItem {
  id: string;
  /** Full host path, already `/lsat`-prefixed (e.g. `/lsat/srs`). */
  path: string;
  label: string;
  /** Host icon key (resolved to a lucide component by the consumer). */
  iconKey: string;
}

/** A labelled group of LSAT nav rows (e.g. "Practice", "Insight"). */
export interface LsatNavGroup {
  /** The host `navGroup` slug (`practice` | `tools` | `ops`). */
  group: string;
  /** Human-facing group heading. */
  label: string;
  items: LsatNavItem[];
}

// Host navGroup slug -> heading shown in the LSAT section. Mirrors the LSAT
// shell's own group names mapped onto the host nav taxonomy (see K4-5).
const GROUP_LABELS: Record<string, string> = {
  practice: 'Practice',
  tools: 'Insight',
  ops: 'Setup',
};

// Stable display order for the groups (matches the LSAT rail: Practice first).
const GROUP_ORDER = ['practice', 'tools', 'ops'];

/** True when a route is a real, navigable LSAT nav row (not an alias/dynamic). */
function isNavRow(route: AppRoute): boolean {
  // Aliases collapse to their canonical target; dynamic/full-bleed routes carry
  // no commandLabel (they aren't in the LSAT manifest's nav list).
  return !route.canonicalPath && Boolean(route.commandLabel);
}

/** Hidden while in Test Mode? Mirrors the LSAT manifest's `hideInTest`. */
function visibleInMode(route: AppRoute, mode: LsatNavMode): boolean {
  return !(mode === 'test' && route.hideInTest);
}

/**
 * Build the grouped LSAT nav section from `lsatAppRoutes`, honoring the active
 * mode (study/test). Groups with no visible rows are dropped, and groups are
 * returned in a stable order (Practice → Insight → Setup).
 */
export function buildLsatNavGroups(mode: LsatNavMode): LsatNavGroup[] {
  const rows = lsatAppRoutes.filter((route) => isNavRow(route) && visibleInMode(route, mode));
  const byGroup = new Map<string, LsatNavItem[]>();
  for (const route of rows) {
    const list = byGroup.get(route.navGroup) ?? [];
    list.push({ id: route.id, path: route.path, label: route.navLabel, iconKey: route.iconKey });
    byGroup.set(route.navGroup, list);
  }
  // Stable order: known groups first (Practice/Insight/Setup), then any others.
  const orderedKeys = [
    ...GROUP_ORDER.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];
  return orderedKeys.map((group) => ({
    group,
    label: GROUP_LABELS[group] ?? group,
    items: byGroup.get(group) as LsatNavItem[],
  }));
}
