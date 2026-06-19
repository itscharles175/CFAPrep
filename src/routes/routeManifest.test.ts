import { describe, expect, it } from 'vitest';
import {
  appRoutes,
  canonicalRoutePath,
  lsatAppRoutes,
  lsatSearchRoutes,
  routeByPath,
  routeLabel,
  routeTree,
  screenshotRoutes,
  smokeRoutes,
} from './routeManifest';

describe('route visual metadata', () => {
  it('assigns cockpit metadata to every app route', () => {
    appRoutes.forEach((route) => {
      expect(route.domain, route.id).toBeTruthy();
      expect(route.navGroup, route.id).toBeTruthy();
      expect(route.iconKey, route.id).toBeTruthy();
      expect(route.accentRole, route.id).toBeTruthy();
      expect(route.preferredLayout, route.id).toBeTruthy();
      expect(route.navOrder, route.id).toBeGreaterThan(0);
      expect(route.navLabel, route.id).toBeTruthy();
      expect(route.searchGroup, route.id).toBeTruthy();
      expect(route.keyboardScopes.length, route.id).toBeGreaterThan(0);
      expect(route.breadcrumbs.length, route.id).toBeGreaterThan(0);
      expect(route.keyboardHelp.length, route.id).toBeGreaterThan(0);
      expect(route.preloadStrategy, route.id).toBeTruthy();
      expect(route.qaStates[0].viewports, route.id).toEqual([320, 375, 414, 768, 1024, 1440]);
    });
  });

  it('derives smoke routes from the typed manifest', () => {
    const smokePaths = new Set(smokeRoutes.map(([path]) => path));
    expect(smokePaths.has('/')).toBe(true);
    expect(smokePaths.has('/cfa/level1/fixed-income/quiz')).toBe(true);
    expect(smokePaths.has('/content-ops')).toBe(true);
  });

  it('exposes visual screenshot routes for the flagship cockpit surfaces', () => {
    const visualPaths = new Set(screenshotRoutes.map((route) => route.path));
    expect(visualPaths.has('/cfa')).toBe(true);
    expect(visualPaths.has('/cfa/level1/fixed-income')).toBe(true);
    expect(visualPaths.has('/cfa/level3/performance/constructed-response')).toBe(true);
    expect(visualPaths.has('/calculators')).toBe(true);
    expect(visualPaths.has('/formulas')).toBe(true);
    expect(visualPaths.has('/quant/risk-management')).toBe(true);
    expect(visualPaths.has('/excel/dcf-modeling')).toBe(true);
    expect(visualPaths.has('/system')).toBe(true);
  });

  it('marks offline-critical learning and vault routes for browser regression coverage', () => {
    const criticalIds = new Set(appRoutes.filter((route) => route.offlineCritical).map((route) => route.id));
    expect(criticalIds.has('cfa-module')).toBe(true);
    expect(criticalIds.has('cfa-quiz')).toBe(true);
    expect(criticalIds.has('vault')).toBe(true);
    expect(criticalIds.has('system')).toBe(true);
    expect(criticalIds.has('today')).toBe(true);
    expect(appRoutes.find((route) => route.id === 'cfa-module')?.offlineWarmup?.priority).toBe('critical');
    expect(appRoutes.find((route) => route.id === 'system')?.routeActions.map((action) => action.id)).toContain('encrypted-backup');
  });

  it('exposes /today as a routable focus-mode landing', () => {
    const today = appRoutes.find((route) => route.id === 'today');
    expect(today).toBeDefined();
    expect(today?.path).toBe('/today');
    expect(today?.navGroup).toBe('home');
    expect(today?.preferredLayout).toBe('dashboard');
    expect(today?.iconKey).toBe('sun');
  });
});

// K4-5 — merged route tree (host + /lsat/* surface) invariants.
describe('K4-5 merged LSAT routes', () => {
  it('leaves the host appRoutes array untouched (no /lsat entries)', () => {
    expect(appRoutes.every((route) => !route.path.startsWith('/lsat'))).toBe(true);
    expect(appRoutes.every((route) => route.domain !== 'lsat')).toBe(true);
  });

  it('prefixes every LSAT route path with /lsat', () => {
    expect(lsatAppRoutes.length).toBeGreaterThan(0);
    lsatAppRoutes.forEach((route) => {
      expect(route.path === '/lsat' || route.path.startsWith('/lsat/'), route.id).toBe(true);
      expect(route.domain, route.id).toBe('lsat');
    });
  });

  it('rewrites the 18 LSAT manifest paths to their /lsat host paths', () => {
    const byId = new Map(lsatAppRoutes.map((route) => [route.id, route]));
    expect(byId.get('lsat-home')?.path).toBe('/lsat');
    expect(byId.get('lsat-dashboard')?.path).toBe('/lsat/dashboard');
    expect(byId.get('lsat-practice')?.path).toBe('/lsat/practice');
    expect(byId.get('lsat-srs')?.path).toBe('/lsat/srs');
    expect(byId.get('lsat-review-history')?.path).toBe('/lsat/review/history');
    expect(byId.get('lsat-settings')?.path).toBe('/lsat/settings');
  });

  it('includes the dynamic + full-bleed LSAT routes (preserving params)', () => {
    const paths = new Set(lsatAppRoutes.map((route) => route.path));
    expect(paths.has('/lsat/take/:sectionId')).toBe(true);
    expect(paths.has('/lsat/exam/:preptestId')).toBe(true);
    expect(paths.has('/lsat/analytics/type/:qType')).toBe(true);
    expect(paths.has('/lsat/blind-review/:sessionId')).toBe(true);
  });

  it('carries commandLabel / keywords / hideInTest / appMode from the LSAT manifest', () => {
    const srs = lsatAppRoutes.find((route) => route.id === 'lsat-srs');
    expect(srs?.commandLabel).toBe('Go to SRS');
    expect(srs?.keywords).toContain('spaced repetition');
    expect(srs?.hideInTest).toBe(true);
    expect(srs?.appMode).toBe('study');

    // /practice has no hideInTest -> visible in both modes.
    const practice = lsatAppRoutes.find((route) => route.id === 'lsat-practice');
    expect(practice?.hideInTest).toBeUndefined();
    expect(practice?.appMode).toBe('both');
  });

  it('rewrites alias canonicalPath into the /lsat space (notebook -> /lsat)', () => {
    const notebook = lsatAppRoutes.find((route) => route.id === 'lsat-notebook');
    expect(notebook?.path).toBe('/lsat/notebook');
    expect(notebook?.canonicalPath).toBe('/lsat');
    expect(canonicalRoutePath('/lsat/notebook')).toBe('/lsat');
    // Home and host routes have no alias -> pass through.
    expect(canonicalRoutePath('/lsat')).toBe('/lsat');
    expect(canonicalRoutePath('/cfa')).toBe('/cfa');
  });

  it('has no id or path collisions across the merged tree', () => {
    const ids = routeTree.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = routeTree.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('unions host + lsat into routeTree', () => {
    expect(routeTree.length).toBe(appRoutes.length + lsatAppRoutes.length);
  });

  it('resolves merged-tree lookups by path and label', () => {
    expect(routeByPath('/lsat/srs')?.id).toBe('lsat-srs');
    expect(routeByPath('/cfa')?.id).toBe('cfa-dashboard');
    expect(routeLabel('/lsat/notebook')).toBe('Notebook OS'); // canonical-aware
    expect(routeLabel('/lsat/srs')).toBe('SRS');
  });

  it('continues LSAT navOrder after the host routes', () => {
    const hostMax = Math.max(...appRoutes.map((route) => route.navOrder));
    expect(lsatAppRoutes.every((route) => route.navOrder > hostMax)).toBe(true);
  });

  it('derives /lsat search rows that mirror the LSAT command list', () => {
    const paths = new Set(lsatSearchRoutes.map((row) => row.path));
    expect(paths.has('/lsat/srs')).toBe(true);
    expect(paths.has('/lsat')).toBe(true);
    // aliases excluded (/lsat/notebook canonicalizes to /lsat)
    expect(paths.has('/lsat/notebook')).toBe(false);
    // dynamic/full-bleed routes excluded (no commandLabel)
    expect(paths.has('/lsat/take/:sectionId')).toBe(false);
  });

  it('keeps the QA-gate crawl confined to the curated stable list pages', () => {
    // The merged smokeRoute/screenshotRoute markers should not include dynamic
    // or alias LSAT routes (those need a started session / are duplicates).
    const gated = lsatAppRoutes.filter((route) => route.smokeRoute);
    expect(gated.every((route) => !route.canonicalPath)).toBe(true);
    expect(gated.some((route) => route.path === '/lsat/srs')).toBe(true);
    expect(gated.some((route) => route.path.includes(':'))).toBe(false);
  });
});
