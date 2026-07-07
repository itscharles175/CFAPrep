import { describe, expect, it } from 'vitest';
import {
  PERFORMANCE_BASELINE_SCHEMA,
  allowedPerformanceValue,
  buildRoutePerformanceBaseline,
  evaluateRoutePerformanceBudget,
} from './route-performance-policy.mjs';

const baseline = {
  schemaVersion: PERFORMANCE_BASELINE_SCHEMA,
  tolerance: { durationRatio: 0.2, durationMs: 100, cls: 0.02 },
  routes: {
    dashboard: {
      path: '/',
      expectedText: 'StudyVault',
      viewports: {
        desktop: {
          phases: {
            cold: { routeReadyMs: 1100, domContentLoadedMs: 1000, loadMs: 1200, fcpMs: 800, lcpMs: 900, cls: 0.02, tbtMs: 100, maxLongTaskMs: 120, inpMs: 200 },
            warm: { routeReadyMs: 550, domContentLoadedMs: 500, loadMs: 600, fcpMs: 300, lcpMs: 400, cls: 0.01, tbtMs: 50, maxLongTaskMs: 80, inpMs: 200 },
          },
        },
      },
    },
  },
};

function measurement(overrides = {}) {
  return {
    routeId: 'dashboard',
    viewport: 'desktop',
    phase: 'cold',
    status: 'ok',
    metrics: { routeReadyMs: 1120, domContentLoadedMs: 1050, loadMs: 1210, fcpMs: 820, lcpMs: 950, cls: 0.015, tbtMs: 125, maxLongTaskMs: 140 },
    ...overrides,
  };
}

describe('route performance budget policy', () => {
  it('applies ratio-or-absolute tolerance for duration metrics and absolute tolerance for CLS', () => {
    expect(allowedPerformanceValue(1000, 'lcpMs', baseline.tolerance)).toBe(1200);
    expect(allowedPerformanceValue(200, 'tbtMs', baseline.tolerance)).toBe(300);
    expect(allowedPerformanceValue(0.05, 'cls', baseline.tolerance)).toBeCloseTo(0.07);
  });

  it('fails closed when a route baseline is missing', () => {
    const result = evaluateRoutePerformanceBudget({
      baseline,
      routeIds: ['dashboard', 'cfa-dashboard'],
      measurements: [measurement(), measurement({ phase: 'warm' })],
    });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.status === 'missing-baseline')).toBe(true);
  });

  it('blocks metrics that exceed the tolerated baseline', () => {
    const result = evaluateRoutePerformanceBudget({
      baseline,
      routeIds: ['dashboard'],
      measurements: [
        measurement({ metrics: { ...measurement().metrics, lcpMs: 1400 } }),
        measurement({ phase: 'warm', metrics: { routeReadyMs: 500, domContentLoadedMs: 500, loadMs: 600, fcpMs: 300, lcpMs: 400, cls: 0.01, tbtMs: 50, maxLongTaskMs: 80 } }),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'dashboard:desktop:cold:lcpMs', status: 'over-budget' }),
      ]),
    );
  });

  it('reports optional INP as not observed unless optional metrics are required', () => {
    const warm = measurement({ phase: 'warm', metrics: { routeReadyMs: 500, domContentLoadedMs: 500, loadMs: 600, fcpMs: 300, lcpMs: 400, cls: 0.01, tbtMs: 50, maxLongTaskMs: 80 } });
    const relaxed = evaluateRoutePerformanceBudget({
      baseline,
      routeIds: ['dashboard'],
      measurements: [measurement(), warm],
    });
    const strict = evaluateRoutePerformanceBudget({
      baseline,
      routeIds: ['dashboard'],
      measurements: [measurement(), warm],
      requireOptionalMetrics: true,
    });

    expect(relaxed.ok).toBe(true);
    expect(relaxed.checks.some((check) => check.metric === 'inpMs' && check.status === 'not-observed')).toBe(true);
    expect(strict.ok).toBe(false);
    expect(strict.failures.some((failure) => failure.scope === 'dashboard:desktop:cold:inpMs')).toBe(true);
  });

  it('builds a stable baseline from cold and warm measurements', () => {
    const generated = buildRoutePerformanceBaseline({
      routes: [{ id: 'dashboard', path: '/', expectedText: 'StudyVault', viewports: ['desktop'] }],
      measurements: [
        measurement({ metrics: { ...measurement().metrics, cls: 0.01234, inpMs: 210.44 } }),
        measurement({ phase: 'warm', metrics: { routeReadyMs: 500, domContentLoadedMs: 500.12, loadMs: 600, fcpMs: 300, lcpMs: 400, cls: 0.01, tbtMs: 50, maxLongTaskMs: 80 } }),
      ],
      generatedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(generated.schemaVersion).toBe(PERFORMANCE_BASELINE_SCHEMA);
    expect(generated.routes.dashboard.viewports.desktop.phases.cold.cls).toBe(0.0123);
    expect(generated.routes.dashboard.viewports.desktop.phases.cold.inpMs).toBe(210.4);
    expect(generated.routes.dashboard.viewports.desktop.phases.warm.domContentLoadedMs).toBe(500.1);
  });
});
