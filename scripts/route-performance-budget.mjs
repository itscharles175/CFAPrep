import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { lsatScreenshotRoutes, screenshotRoutes } from '../src/routes/routeManifest.ts';
import { resolveBrowserExecutable } from './a11y-helpers.mjs';
import { viewports as viewportSizes } from './qa-helpers.mjs';
import {
  buildRoutePerformanceBaseline,
  evaluateRoutePerformanceBudget,
} from './route-performance-policy.mjs';

/* global document, window */

const BASELINE_PATH = 'tests/performance-baseline.json';
const REPORT_PATH = 'dist/reports/perf-regression.json';
const UPDATE_BASELINE = process.env.UPDATE_PERF_BASELINES === '1';
const REQUIRE_INP = process.env.REQUIRE_INP_PERF === '1';
const ROUTE_SETTLE_MS = Number(process.env.PERF_ROUTE_SETTLE_MS || 900);
const ROUTE_TIMEOUT_MS = Number(process.env.PERF_ROUTE_TIMEOUT_MS || 45_000);
const VIEWPORT_NAMES = ['desktop', 'mobile'];

const HOST_PERF_ROUTE_IDS = [
  'dashboard',
  'cfa-dashboard',
  'cfa-vignette',
  'cfa-constructed-response',
  'level-mock',
];
const LSAT_PERF_ROUTE_IDS = ['lsat-home', 'lsat-preptests'];

function routeMap(routes) {
  return new Map(routes.map((route) => [route.id, route]));
}

function pickRoutes(sourceRoutes, routeIds) {
  const byId = routeMap(sourceRoutes);
  return routeIds.map((id) => {
    const route = byId.get(id);
    if (!route) throw new Error(`Performance route "${id}" is not in the route manifest.`);
    return { id: route.id, path: route.path, expectedText: route.expectedText };
  });
}

export function performanceBudgetRoutes() {
  return [
    ...pickRoutes(screenshotRoutes, HOST_PERF_ROUTE_IDS),
    ...pickRoutes(lsatScreenshotRoutes, LSAT_PERF_ROUTE_IDS),
  ].map((route) => ({ ...route, viewports: VIEWPORT_NAMES }));
}

async function waitForRouteReady(page, text, label) {
  await page
    .waitForFunction(
      (expected) => {
        const bodyText = document.body?.innerText || '';
        const routeScopes = [
          ...document.querySelectorAll('main, [role="main"], h1, h2, [data-route-ready]'),
        ]
          .map((node) => node.textContent || '')
          .join('\n');
        return document.readyState !== 'loading' && (routeScopes.includes(expected) || bodyText.includes(expected));
      },
      text,
      { timeout: ROUTE_TIMEOUT_MS },
    )
    .catch((error) => {
      throw new Error(`Timed out waiting for ${label}: ${error.message}`);
    });
}

async function installPerformanceCollector(page) {
  await page.addInitScript(() => {
    window.__studyvaultRoutePerf = {
      lcpMs: null,
      cls: 0,
      inpMs: null,
      tbtMs: 0,
      maxLongTaskMs: 0,
      longTaskCount: 0,
      longTasks: [],
    };

    const observe = (type, callback) => {
      try {
        const observer = new PerformanceObserver((list) => callback(list.getEntries()));
        observer.observe({ type, buffered: true });
      } catch {
        // Unsupported in this browser; the matching metric stays null/zero.
      }
    };

    observe('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1];
      if (last) window.__studyvaultRoutePerf.lcpMs = last.startTime;
    });

    let clsValue = 0;
    let sessionValue = 0;
    let sessionFirst = 0;
    let sessionLast = 0;
    observe('layout-shift', (entries) => {
      for (const entry of entries) {
        if (entry.hadRecentInput) continue;
        if (sessionValue && (entry.startTime - sessionLast >= 1000 || entry.startTime - sessionFirst >= 5000)) {
          sessionValue = 0;
        }
        if (sessionValue === 0) sessionFirst = entry.startTime;
        sessionLast = entry.startTime;
        sessionValue += entry.value;
        clsValue = Math.max(clsValue, sessionValue);
      }
      window.__studyvaultRoutePerf.cls = clsValue;
    });

    const recordInteraction = (entries) => {
      for (const entry of entries) {
        const isInteraction = entry.entryType === 'first-input' || (entry.interactionId ?? 0) > 0;
        if (!isInteraction) continue;
        window.__studyvaultRoutePerf.inpMs = Math.max(window.__studyvaultRoutePerf.inpMs ?? 0, entry.duration);
      }
    };
    observe('event', recordInteraction);
    observe('first-input', recordInteraction);

    observe('longtask', (entries) => {
      for (const entry of entries) {
        const blockingMs = Math.max(0, entry.duration - 50);
        window.__studyvaultRoutePerf.tbtMs += blockingMs;
        window.__studyvaultRoutePerf.maxLongTaskMs = Math.max(
          window.__studyvaultRoutePerf.maxLongTaskMs,
          entry.duration,
        );
        window.__studyvaultRoutePerf.longTaskCount += 1;
        window.__studyvaultRoutePerf.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          blockingMs,
        });
      }
    });
  });
}

async function readRouteMetrics(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paintEntries = performance.getEntriesByType('paint');
    const fcp = paintEntries.find((entry) => entry.name === 'first-contentful-paint');
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    const lastLcp = lcpEntries[lcpEntries.length - 1];
    const collected = window.__studyvaultRoutePerf || {};
    const navStart = nav?.startTime ?? 0;
    const duration = (value) => (Number.isFinite(value) && value > 0 ? value - navStart : null);
    const observedLcpMs = Number.isFinite(collected.lcpMs)
      ? collected.lcpMs
      : Number.isFinite(lastLcp?.startTime)
        ? lastLcp.startTime
        : null;

    return {
      domContentLoadedMs: duration(nav?.domContentLoadedEventEnd),
      loadMs: duration(nav?.loadEventEnd),
      fcpMs: Number.isFinite(fcp?.startTime) ? fcp.startTime : null,
      lcpMs: observedLcpMs,
      lcpSource: observedLcpMs == null ? null : 'largest-contentful-paint',
      cls: Number.isFinite(collected.cls) ? collected.cls : 0,
      inpMs: Number.isFinite(collected.inpMs) ? collected.inpMs : null,
      tbtMs: Number.isFinite(collected.tbtMs) ? collected.tbtMs : 0,
      maxLongTaskMs: Number.isFinite(collected.maxLongTaskMs) ? collected.maxLongTaskMs : 0,
      longTaskCount: Number.isFinite(collected.longTaskCount) ? collected.longTaskCount : 0,
      transferSizeBytes: Number.isFinite(nav?.transferSize) ? nav.transferSize : null,
      encodedBodySizeBytes: Number.isFinite(nav?.encodedBodySize) ? nav.encodedBodySize : null,
      decodedBodySizeBytes: Number.isFinite(nav?.decodedBodySize) ? nav.decodedBodySize : null,
    };
  });
}

async function measureRoutePhase({ page, address, route, viewport, phase, runtimeErrors }) {
  try {
    runtimeErrors.length = 0;
    const url = new URL(route.path, address).toString();
    const startedAt = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ROUTE_TIMEOUT_MS });
    await waitForRouteReady(page, route.expectedText, `${route.id} ${viewport} ${phase}`);
    const routeReadyMs = Date.now() - startedAt;
    await page.keyboard.press('Tab').catch(() => undefined);
    await page.waitForTimeout(ROUTE_SETTLE_MS);
    const observedMetrics = await readRouteMetrics(page);
    const fallbackLcpMs = observedMetrics.lcpMs ?? observedMetrics.fcpMs ?? routeReadyMs;
    const metrics = {
      ...observedMetrics,
      routeReadyMs,
      lcpMs: fallbackLcpMs,
      lcpSource:
        observedMetrics.lcpSource ??
        (observedMetrics.fcpMs != null ? 'first-contentful-paint-fallback' : 'route-ready-fallback'),
    };
    const body = await page.locator('body').innerText({ timeout: 10_000 });
    if (/TypeError|ReferenceError|Cannot read|Failed to fetch/i.test(body)) {
      throw new Error(`Runtime error text detected during ${route.id} ${phase}`);
    }
    if (runtimeErrors.length) {
      throw new Error(`Console/runtime error during ${route.id} ${phase}: ${runtimeErrors.slice(0, 2).join('; ')}`);
    }
    return {
      routeId: route.id,
      path: route.path,
      expectedText: route.expectedText,
      viewport,
      phase,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      url,
      metrics,
    };
  } catch (error) {
    return {
      routeId: route.id,
      path: route.path,
      expectedText: route.expectedText,
      viewport,
      phase,
      status: 'blocked',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function measureRouteViewport({ browser, address, route, viewport }) {
  const allowedOrigin = new URL(address).origin;
  const context = await browser.newContext({
    viewport: viewportSizes[viewport],
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route('**/*', async (routeRequest) => {
    const requestUrl = new URL(routeRequest.request().url());
    const isLoopback = requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost';
    if (isLoopback && requestUrl.origin !== allowedOrigin) {
      await routeRequest.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, offline: true, source: 'perf-regression-stub' }),
      });
      return;
    }
    await routeRequest.continue();
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await installPerformanceCollector(page);

  try {
    const cold = await measureRoutePhase({ page, address, route, viewport, phase: 'cold', runtimeErrors });
    const warm = await measureRoutePhase({ page, address, route, viewport, phase: 'warm', runtimeErrors });
    return [cold, warm];
  } finally {
    await context.close();
  }
}

async function measureRoute({ browser, address, route }) {
  const results = [];
  for (const viewport of route.viewports) {
    results.push(...(await measureRouteViewport({ browser, address, route, viewport })));
  }
  return results;
}

async function readBaseline() {
  const raw = await readFile(BASELINE_PATH, 'utf8');
  return JSON.parse(raw);
}

async function writeReport(report) {
  await mkdir('dist/reports', { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

export async function runRoutePerformanceBudget() {
  await access('dist/index.html').catch(() => {
    throw new Error('Production dist is missing. Run npm run build before perf:regression.');
  });

  const routes = performanceBudgetRoutes();
  const server = await preview({
    preview: {
      host: '127.0.0.1',
      port: 4177,
      strictPort: false,
      open: false,
    },
  });
  const executablePath = await resolveBrowserExecutable();
  if (!executablePath) {
    await new Promise((resolve) => server.httpServer.close(resolve));
    throw new Error(
      'No Chromium-compatible browser found for route performance budgets. Install Chrome/Edge, ' +
        'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium" (CI does this).',
    );
  }

  const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4177/';
  const browser = await chromium.launch({ executablePath, headless: true });
  const measurements = [];
  let report;

  try {
    for (const route of routes) {
      const routeMeasurements = await measureRoute({ browser, address, route });
      measurements.push(...routeMeasurements);
      for (const row of routeMeasurements) {
        if (row.status === 'ok') {
          console.log(
            `OK perf ${row.routeId} ${row.viewport} ${row.phase} ` +
              `LCP=${Math.round(row.metrics.lcpMs ?? 0)}ms TBT=${Math.round(row.metrics.tbtMs ?? 0)}ms CLS=${row.metrics.cls.toFixed(4)}`,
          );
        } else {
          console.error(`BLOCKED perf ${row.routeId} ${row.viewport} ${row.phase} - ${row.message}`);
        }
      }
    }

    const measurementFailures = measurements.filter((row) => row.status !== 'ok');
    let baseline = UPDATE_BASELINE ? null : await readBaseline();
    if (UPDATE_BASELINE && measurementFailures.length === 0) {
      baseline = buildRoutePerformanceBaseline({ routes, measurements });
      await mkdir('tests', { recursive: true });
      await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    }

    const budget = baseline
      ? evaluateRoutePerformanceBudget({
          baseline,
          measurements,
          routeIds: routes.map((route) => route.id),
          viewports: VIEWPORT_NAMES,
          requireOptionalMetrics: REQUIRE_INP,
        })
      : {
          status: measurementFailures.length ? 'blocked' : 'update',
          ok: measurementFailures.length === 0,
          failures: measurementFailures.map((row) => ({
            scope: `${row.routeId}:${row.viewport}:${row.phase}`,
            status: row.status,
            message: row.message,
          })),
        };

    report = {
      generatedAt: new Date().toISOString(),
      baselinePath: BASELINE_PATH,
      updateBaseline: UPDATE_BASELINE,
      requireInp: REQUIRE_INP,
      viewports: VIEWPORT_NAMES,
      routeCount: routes.length,
      phaseCount: measurements.length,
      routes,
      measurements,
      budget,
    };
    await writeReport(report);

    if (!budget.ok) {
      console.error(JSON.stringify(budget.failures, null, 2));
      throw new Error(`${budget.failures.length} route performance budget check(s) failed.`);
    }

    return report;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
    if (!report) {
      await writeReport({
        generatedAt: new Date().toISOString(),
        baselinePath: BASELINE_PATH,
        updateBaseline: UPDATE_BASELINE,
        requireInp: REQUIRE_INP,
        viewports: VIEWPORT_NAMES,
        routeCount: routes.length,
        phaseCount: measurements.length,
        routes,
        measurements,
        budget: {
          status: 'blocked',
          ok: false,
          failures: [{ scope: 'runner', message: 'route performance runner exited before budget evaluation' }],
        },
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRoutePerformanceBudget();
}
