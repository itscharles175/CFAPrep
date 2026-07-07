export const PERFORMANCE_BASELINE_SCHEMA = 'studyvault.route-performance-baseline.v1';

export const DEFAULT_PERFORMANCE_TOLERANCE = {
  durationRatio: 0.2,
  durationMs: 250,
  cls: 0.02,
};

export const REQUIRED_PERFORMANCE_METRICS = [
  'routeReadyMs',
  'fcpMs',
  'lcpMs',
  'cls',
  'tbtMs',
  'maxLongTaskMs',
];

export const OPTIONAL_PERFORMANCE_METRICS = ['inpMs'];
export const DIAGNOSTIC_PERFORMANCE_METRICS = ['domContentLoadedMs', 'loadMs'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function allowedPerformanceValue(baselineValue, metric, tolerance = DEFAULT_PERFORMANCE_TOLERANCE) {
  if (!isFiniteNumber(baselineValue)) return null;
  if (metric === 'cls') return baselineValue + (tolerance.cls ?? DEFAULT_PERFORMANCE_TOLERANCE.cls);
  return (
    baselineValue +
    Math.max(
      tolerance.durationMs ?? DEFAULT_PERFORMANCE_TOLERANCE.durationMs,
      baselineValue * (tolerance.durationRatio ?? DEFAULT_PERFORMANCE_TOLERANCE.durationRatio),
    )
  );
}

function measurementKey({ routeId, viewport = 'desktop', phase }) {
  return `${routeId}:${viewport}:${phase}`;
}

function normalizeMeasurementMap(measurements) {
  const map = new Map();
  for (const row of measurements || []) {
    if (!row?.routeId || !row?.phase) continue;
    map.set(measurementKey(row), row);
  }
  return map;
}

export function evaluateRoutePerformanceBudget({
  baseline,
  measurements,
  routeIds,
  viewports = ['desktop'],
  phases = ['cold', 'warm'],
  requiredMetrics = REQUIRED_PERFORMANCE_METRICS,
  optionalMetrics = OPTIONAL_PERFORMANCE_METRICS,
  requireOptionalMetrics = false,
} = {}) {
  const tolerance = baseline?.tolerance ?? DEFAULT_PERFORMANCE_TOLERANCE;
  const routes = baseline?.routes ?? {};
  const expectedRouteIds = [...new Set(routeIds || Object.keys(routes))].sort();
  const measurementMap = normalizeMeasurementMap(measurements);
  const checks = [];
  const failures = [];

  if (!baseline || baseline.schemaVersion !== PERFORMANCE_BASELINE_SCHEMA) {
    failures.push({
      scope: 'baseline',
      status: 'blocked',
      message: `performance baseline must use schema ${PERFORMANCE_BASELINE_SCHEMA}`,
    });
  }

  if (expectedRouteIds.length === 0) {
    failures.push({
      scope: 'baseline',
      status: 'blocked',
      message: 'route performance gate has no expected routes',
    });
  }

  for (const routeId of expectedRouteIds) {
    const routeBaseline = routes[routeId];
    if (!routeBaseline) {
      failures.push({
        scope: routeId,
        status: 'missing-baseline',
        message: `missing performance baseline for route ${routeId}`,
      });
      continue;
    }

    for (const viewport of viewports) {
      const viewportBaseline = routeBaseline.viewports?.[viewport] ?? routeBaseline;

      if (!viewportBaseline) {
        failures.push({
          scope: `${routeId}:${viewport}`,
          status: 'missing-baseline',
          message: `missing ${viewport} performance baseline for route ${routeId}`,
        });
        continue;
      }

      for (const phase of phases) {
        const phaseBaseline = viewportBaseline.phases?.[phase];
        const measurement = measurementMap.get(measurementKey({ routeId, viewport, phase }));

        if (!phaseBaseline) {
          failures.push({
            scope: `${routeId}:${viewport}:${phase}`,
            status: 'missing-baseline',
            message: `missing ${phase} performance baseline for route ${routeId} ${viewport}`,
          });
          continue;
        }

        if (!measurement) {
          failures.push({
            scope: `${routeId}:${viewport}:${phase}`,
            status: 'missing-measurement',
            message: `missing ${phase} performance measurement for route ${routeId} ${viewport}`,
          });
          continue;
        }

        if (measurement.status && measurement.status !== 'ok') {
          failures.push({
            scope: `${routeId}:${viewport}:${phase}`,
            status: measurement.status,
            message: measurement.message || `route ${routeId} ${viewport} ${phase} measurement failed`,
          });
          continue;
        }

        const metricNames = requireOptionalMetrics
          ? [...requiredMetrics, ...optionalMetrics]
          : requiredMetrics;
        for (const metric of metricNames) {
          const baselineValue = phaseBaseline[metric];
          const value = measurement.metrics?.[metric];
          const allowed = allowedPerformanceValue(baselineValue, metric, tolerance);
          const check = {
            routeId,
            viewport,
            phase,
            metric,
            value: isFiniteNumber(value) ? value : null,
            baseline: isFiniteNumber(baselineValue) ? baselineValue : null,
            allowed,
            status: 'ok',
          };

          if (!isFiniteNumber(baselineValue)) {
            check.status = 'missing-baseline';
            failures.push({
              scope: `${routeId}:${viewport}:${phase}:${metric}`,
              status: check.status,
              message: `missing ${metric} baseline for ${routeId} ${viewport} ${phase}`,
            });
          } else if (!isFiniteNumber(value)) {
            check.status = 'missing-measurement';
            failures.push({
              scope: `${routeId}:${viewport}:${phase}:${metric}`,
              status: check.status,
              message: `missing ${metric} measurement for ${routeId} ${viewport} ${phase}`,
            });
          } else if (allowed != null && value > allowed) {
            check.status = 'over-budget';
            failures.push({
              scope: `${routeId}:${viewport}:${phase}:${metric}`,
              status: check.status,
              message: `${routeId} ${viewport} ${phase} ${metric} ${value.toFixed(2)} exceeded allowed ${allowed.toFixed(2)}`,
              value,
              baseline: baselineValue,
              allowed,
            });
          }
          checks.push(check);
        }

        if (!requireOptionalMetrics) {
          for (const metric of optionalMetrics) {
            const baselineValue = phaseBaseline[metric];
            const value = measurement.metrics?.[metric];
            if (!isFiniteNumber(baselineValue) || !isFiniteNumber(value)) {
              checks.push({
                routeId,
                viewport,
                phase,
                metric,
                value: isFiniteNumber(value) ? value : null,
                baseline: isFiniteNumber(baselineValue) ? baselineValue : null,
                allowed: isFiniteNumber(baselineValue)
                  ? allowedPerformanceValue(baselineValue, metric, tolerance)
                  : null,
                status: 'not-observed',
              });
              continue;
            }

            const allowed = allowedPerformanceValue(baselineValue, metric, tolerance);
            const status = allowed != null && value > allowed ? 'over-budget' : 'ok';
            checks.push({ routeId, viewport, phase, metric, value, baseline: baselineValue, allowed, status });
            if (status === 'over-budget') {
              failures.push({
                scope: `${routeId}:${viewport}:${phase}:${metric}`,
                status,
                message: `${routeId} ${viewport} ${phase} ${metric} ${value.toFixed(2)} exceeded allowed ${allowed.toFixed(2)}`,
                value,
                baseline: baselineValue,
                allowed,
              });
            }
          }
        }
      }
    }
  }

  return {
    status: failures.length ? 'blocked' : 'ok',
    ok: failures.length === 0,
    expectedRouteIds,
    checks,
    failures,
    tolerance,
  };
}

export function buildRoutePerformanceBaseline({
  routes,
  measurements,
  tolerance = DEFAULT_PERFORMANCE_TOLERANCE,
  generatedAt = new Date().toISOString(),
} = {}) {
  const measurementMap = normalizeMeasurementMap(measurements);
  const baselineRoutes = {};

  for (const route of routes || []) {
    const viewports = {};
    const viewportNames = route.viewports || ['desktop'];
    for (const viewport of viewportNames) {
      const phases = {};
      for (const phase of ['cold', 'warm']) {
        const measurement = measurementMap.get(measurementKey({ routeId: route.id, viewport, phase }));
        if (!measurement?.metrics) continue;
        phases[phase] = {};
        for (const metric of [
          ...REQUIRED_PERFORMANCE_METRICS,
          ...DIAGNOSTIC_PERFORMANCE_METRICS,
          ...OPTIONAL_PERFORMANCE_METRICS,
        ]) {
          const value = measurement.metrics[metric];
          if (isFiniteNumber(value)) phases[phase][metric] = Number(value.toFixed(metric === 'cls' ? 4 : 1));
        }
      }
      viewports[viewport] = { phases };
    }
    baselineRoutes[route.id] = {
      path: route.path,
      expectedText: route.expectedText,
      viewports,
    };
  }

  return {
    schemaVersion: PERFORMANCE_BASELINE_SCHEMA,
    generatedAt,
    tolerance,
    routes: baselineRoutes,
  };
}
