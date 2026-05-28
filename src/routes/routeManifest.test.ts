import { describe, expect, it } from 'vitest';
import { appRoutes, screenshotRoutes, smokeRoutes } from './routeManifest';

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
