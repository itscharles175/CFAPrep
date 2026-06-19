/*
 * K4-cmd — host palette LSAT entries.
 *
 * These rows are the LSAT half of the unified ⌘K: the LSAT route vocabulary +
 * the LSAT palette's cmdk Recents, surfaced as first-class host-palette rows
 * (gated behind LSAT_UNIFIED_SHELL by the caller). The tests pin: the rows are
 * `/lsat`-prefixed + `external` (so they soft-navigate cross-domain), Test Mode
 * honors `hideInTest`, and Recents read the LSAT writer's localStorage key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lsatRecentEntries, lsatRouteEntries } from './lsatPaletteEntries';
import { lsatSearchRoutes, lsatAppRoutes } from '../routes/routeManifest';

const LSAT_COMMAND_RECENTS_KEY = 'lsatlab.commandRecents';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe('lsatRouteEntries', () => {
  it('mirrors the lsatSearchRoutes vocabulary as external /lsat rows', () => {
    const rows = lsatRouteEntries();
    expect(rows.length).toBe(lsatSearchRoutes.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.external).toBe(true);
      expect(row.type).toBe('LSAT');
      // Every LSAT palette row navigates into the /lsat plane.
      expect(row.path === '/lsat' || row.path.startsWith('/lsat/')).toBe(true);
    }
    // The SRS route is part of the LSAT vocabulary and should appear.
    expect(rows.some((r) => r.path === '/lsat/srs')).toBe(true);
  });

  it('carries the manifest command label + keywords for fuzzy matching', () => {
    const srs = lsatRouteEntries().find((r) => r.path === '/lsat/srs');
    const manifestSrs = lsatSearchRoutes.find((r) => r.path === '/lsat/srs');
    expect(srs?.subtitle).toBe(manifestSrs?.subtitle);
    expect(srs?.keywords).toEqual(manifestSrs?.keywords);
  });

  it('drops hideInTest routes in Test Mode but keeps them in Study Mode', () => {
    const hidden = lsatAppRoutes.filter(
      (route) => route.hideInTest && lsatSearchRoutes.some((s) => s.path === route.path),
    );
    expect(hidden.length).toBeGreaterThan(0);
    const study = lsatRouteEntries({ testMode: false });
    const test = lsatRouteEntries({ testMode: true });
    for (const route of hidden) {
      expect(study.some((r) => r.path === route.path)).toBe(true);
      expect(test.some((r) => r.path === route.path)).toBe(false);
    }
    // Test Mode is a strict subset of Study Mode.
    expect(test.length).toBeLessThan(study.length);
  });
});

describe('lsatRecentEntries', () => {
  it('returns nothing when there is no stored recents list', () => {
    expect(lsatRecentEntries()).toEqual([]);
  });

  it('maps stored app-relative recent paths to /lsat-prefixed Recent rows', () => {
    // The LSAT recents writer stores APP-RELATIVE paths (no /lsat prefix).
    localStorage.setItem(LSAT_COMMAND_RECENTS_KEY, JSON.stringify(['/srs', '/drills']));
    const rows = lsatRecentEntries();
    expect(rows.map((r) => r.path)).toEqual(['/lsat/srs', '/lsat/drills']);
    for (const row of rows) {
      expect(row.type).toBe('Recent');
      expect(row.subtitle).toBe('Recent');
      expect(row.external).toBe(true);
    }
  });

  it('preserves recency order and de-dupes repeats', () => {
    localStorage.setItem(
      LSAT_COMMAND_RECENTS_KEY,
      JSON.stringify(['/drills', '/srs', '/drills']),
    );
    const rows = lsatRecentEntries();
    expect(rows.map((r) => r.path)).toEqual(['/lsat/drills', '/lsat/srs']);
  });

  it('skips recents that do not map to a known navigable LSAT route', () => {
    // Dynamic/full-bleed paths (take/exam/etc.) are not in lsatSearchRoutes.
    localStorage.setItem(
      LSAT_COMMAND_RECENTS_KEY,
      JSON.stringify(['/take/42', '/srs', '/not-a-route']),
    );
    const rows = lsatRecentEntries();
    expect(rows.map((r) => r.path)).toEqual(['/lsat/srs']);
  });

  it('drops hideInTest recents in Test Mode', () => {
    const hiddenRoute = lsatAppRoutes.find(
      (route) => route.hideInTest && lsatSearchRoutes.some((s) => s.path === route.path),
    );
    expect(hiddenRoute).toBeDefined();
    const appPath = hiddenRoute!.path.replace(/^\/lsat/, '') || '/';
    localStorage.setItem(LSAT_COMMAND_RECENTS_KEY, JSON.stringify([appPath]));
    expect(lsatRecentEntries({ testMode: false }).length).toBe(1);
    expect(lsatRecentEntries({ testMode: true })).toEqual([]);
  });

  it('degrades to no rows on malformed storage', () => {
    localStorage.setItem(LSAT_COMMAND_RECENTS_KEY, '{not json');
    expect(lsatRecentEntries()).toEqual([]);
    localStorage.setItem(LSAT_COMMAND_RECENTS_KEY, JSON.stringify({ not: 'an array' }));
    expect(lsatRecentEntries()).toEqual([]);
  });

  it('caps recents at 5 rows', () => {
    // Use distinct known routes; lsatSearchRoutes has well over 5 entries.
    const appPaths = lsatSearchRoutes.slice(0, 7).map((r) => r.path.replace(/^\/lsat/, '') || '/');
    localStorage.setItem(LSAT_COMMAND_RECENTS_KEY, JSON.stringify(appPaths));
    expect(lsatRecentEntries({ testMode: false }).length).toBeLessThanOrEqual(5);
  });
});
