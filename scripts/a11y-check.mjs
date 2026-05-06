import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { screenshotRoutes } from '../src/routes/routeManifest.ts';
import {
  applySourceState,
  browserCandidates,
  firstExistingPath,
  routePathForSourceState,
  routeSourceStates,
  summarizeRouteFailures,
  viewports,
} from './qa-helpers.mjs';

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

const executablePath = await firstExistingPath(browserCandidates);
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error('No local Chromium-compatible browser executable found for accessibility checks.');
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4175/';
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: viewports.desktop });
const page = await context.newPage();
const failures = [];
const routeResults = [];

try {
  for (const route of screenshotRoutes) {
    for (const sourceState of routeSourceStates(route)) {
      for (const viewportName of route.viewports) {
        const startedAt = Date.now();
        const path = routePathForSourceState(route, sourceState);
        const url = new URL(path, address).toString();
        try {
          await page.setViewportSize(viewports[viewportName]);
          await applySourceState(page, address, sourceState);
          await page.goto(url, { waitUntil: 'networkidle' });
          await waitForBodyText(page, route.expectedText, `${route.id} ${viewportName} ${sourceState}`);
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
            status: violations.length ? 'blocked' : 'ok',
            durationMs: Date.now() - startedAt,
            url,
            violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
          });
          if (violations.length) {
            failures.push({
              route: `${route.id} ${viewportName} ${sourceState}`,
              violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
            });
          }
          console.log(`OK a11y scanned ${route.id} ${viewportName} ${sourceState}`);
        } catch (error) {
          failures.push({
            route: `${route.id} ${viewportName} ${sourceState}`,
            violations: [error instanceof Error ? error.message : String(error)],
          });
          routeResults.push({
            routeId: route.id,
            path,
            expectedText: route.expectedText,
            viewport: viewportName,
            sourceState,
            status: 'blocked',
            durationMs: Date.now() - startedAt,
            url,
            violations: [error instanceof Error ? error.message : String(error)],
          });
        }
      }
    }
  }
} finally {
  await mkdir('dist/reports', { recursive: true });
  const routeFailures = summarizeRouteFailures(routeResults);
  await writeFile(
    'dist/reports/a11y-check.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), routeResults, routeFailures }, null, 2)}\n`,
  );
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} route(s) have serious or critical accessibility violations.`);
}
