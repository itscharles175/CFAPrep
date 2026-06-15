import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { lsatScreenshotRoutes, screenshotRoutes } from '../src/routes/routeManifest.ts';
import {
  applySourceState,
  routePathForSourceState,
  routeSourceStates,
  selectGateRoutes,
  summarizeRouteFailures,
  viewports,
} from './qa-helpers.mjs';
import {
  a11yThemes,
  contrastMatrix,
  resolveBrowserExecutable,
  seedThemeInitScript,
} from './a11y-helpers.mjs';

/* global document */

async function waitForBodyText(page, text, label) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    text,
    { timeout: 20_000 },
  ).catch((error) => {
    throw new Error(`Timed out waiting for ${label}: ${error.message}`);
  });
}

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before a11y:check.');
});

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: false,
    open: false,
  },
});

const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error(
    'No Chromium-compatible browser found for accessibility checks. Install a system Chrome/Edge, ' +
      'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium" (CI does this).',
  );
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4175/';
const browser = await chromium.launch({ executablePath, headless: true });

// QA-1 / K4-0 — the routes Pass 1 sweeps. Host `screenshotRoutes` by default;
// host ∪ LSAT (or LSAT-only) when INCLUDE_LSAT_ROUTES / LSAT_ROUTES_ONLY are set
// (the dedicated `lsat-qa-gates` CI job). Both lists share the shape this gate
// reads (id, path, expectedText, viewports), so the sweep is uniform — LSAT
// routes get `routeSourceStates(route)` → ['default'] (their ids aren't in the
// vault/cfa special-cased sets) and both viewports from `route.viewports`.
const gateRoutes = selectGateRoutes(screenshotRoutes, lsatScreenshotRoutes);

const failures = [];
const routeResults = [];
const contrastResults = [];

// A fresh context per theme so the seeded `localStorage['qv-theme']` (and thus
// the bootstrap's `data-theme`) is isolated and applied before first paint.
async function withThemeContext(theme, run) {
  const context = await browser.newContext({ viewport: viewports.desktop });
  await seedThemeInitScript(context, theme);
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

try {
  // ── Pass 1: broad WCAG 2.1 A/AA scan across every screenshot route, in BOTH
  // themes and BOTH viewports. Fails on serious/critical violations (matching
  // the prior gate's threshold) so existing route coverage is unchanged beyond
  // now also covering the light palette.
  for (const theme of a11yThemes) {
    await withThemeContext(theme, async (page) => {
      for (const route of gateRoutes) {
        for (const sourceState of routeSourceStates(route)) {
          for (const viewportName of route.viewports) {
            const startedAt = Date.now();
            const path = routePathForSourceState(route, sourceState);
            const url = new URL(path, address).toString();
            const scope = `${route.id} ${viewportName} ${sourceState} [${theme}]`;
            try {
              await page.setViewportSize(viewports[viewportName]);
              await applySourceState(page, address, sourceState);
              await page.goto(url, { waitUntil: 'networkidle' });
              await waitForBodyText(page, route.expectedText, scope);
              await page.waitForTimeout(1800);
              const result = await new AxeBuilder({ page })
                .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
                .analyze();
              const violations = result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
              routeResults.push({
                routeId: route.id,
                path,
                expectedText: route.expectedText,
                viewport: viewportName,
                sourceState,
                theme,
                status: violations.length ? 'blocked' : 'ok',
                durationMs: Date.now() - startedAt,
                url,
                violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
              });
              if (violations.length) {
                failures.push({
                  route: scope,
                  violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
                });
              }
              console.log(`OK a11y scanned ${scope}`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failures.push({ route: scope, violations: [message] });
              routeResults.push({
                routeId: route.id,
                path,
                expectedText: route.expectedText,
                viewport: viewportName,
                sourceState,
                theme,
                status: 'blocked',
                durationMs: Date.now() - startedAt,
                url,
                violations: [message],
              });
            }
          }
        }
      }
    });
  }

  // ── Pass 2: focused WCAG AA CONTRAST gate (UC2). For the curated primitives /
  // chart / per-domain-accent surfaces, run axe restricted to color-contrast and
  // fail on ANY violation regardless of impact — an AA contrast miss is never
  // "minor" for this gate. Theme is driven via the seeded `data-theme`; the
  // per-domain light-mode accents come from App.jsx applying `data-domain` on
  // the /cfa, /excel, /quant routes under the light palette (see a11y-helpers).
  for (const entry of contrastMatrix) {
    for (const theme of entry.themes) {
      await withThemeContext(theme, async (page) => {
        const startedAt = Date.now();
        const url = new URL(entry.path, address).toString();
        const scope = `contrast:${entry.id} [${theme}]`;
        try {
          await page.setViewportSize(viewports.desktop);
          await page.goto(url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1800);
          // color-contrast IS the WCAG 1.4.3 AA rule; withRules sets runOnly to
          // exactly this rule (it overrides withTags), so the pass measures only
          // AA text/background contrast.
          const result = await new AxeBuilder({ page })
            .withRules(['color-contrast'])
            .analyze();
          const violations = result.violations;
          contrastResults.push({
            id: entry.id,
            label: entry.label,
            path: entry.path,
            theme,
            status: violations.length ? 'blocked' : 'ok',
            durationMs: Date.now() - startedAt,
            url,
            violations: violations.flatMap((violation) =>
              violation.nodes.map((node) => `${violation.id}: ${(node.target || []).join(' ')} — ${(node.failureSummary || violation.help).replace(/\s+/g, ' ').trim()}`),
            ),
          });
          if (violations.length) {
            failures.push({
              route: scope,
              violations: violations.flatMap((violation) =>
                violation.nodes.map((node) => `${violation.id}: ${(node.target || []).join(' ')}`),
              ),
            });
          }
          console.log(`OK a11y contrast ${scope} (${entry.label})`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ route: scope, violations: [message] });
          contrastResults.push({
            id: entry.id,
            label: entry.label,
            path: entry.path,
            theme,
            status: 'blocked',
            durationMs: Date.now() - startedAt,
            url,
            violations: [message],
          });
        }
      });
    }
  }
} finally {
  await mkdir('dist/reports', { recursive: true });
  const routeFailures = summarizeRouteFailures(routeResults);
  await writeFile(
    'dist/reports/a11y-check.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), themes: a11yThemes, routeResults, routeFailures, contrastResults }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} accessibility / contrast check(s) failed (WCAG AA, light + dark).`);
}
