import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { screenshotRoutes } from '../src/routes/routeManifest.ts';

/* global document */

const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
].filter(Boolean);

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const failures = [];
const routeResults = [];

try {
  for (const route of screenshotRoutes) {
    const startedAt = Date.now();
    const url = new URL(route.path, address).toString();
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await waitForBodyText(page, route.expectedText, route.id);
      await page.waitForTimeout(1800);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
      routeResults.push({
        routeId: route.id,
        path: route.path,
        status: violations.length ? 'blocked' : 'ok',
        durationMs: Date.now() - startedAt,
        violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
      });
      if (violations.length) {
        failures.push({
          route: route.id,
          violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
        });
      }
      console.log(`OK a11y scanned ${route.id}`);
    } catch (error) {
      failures.push({
        route: route.id,
        violations: [error instanceof Error ? error.message : String(error)],
      });
      routeResults.push({
        routeId: route.id,
        path: route.path,
        status: 'blocked',
        durationMs: Date.now() - startedAt,
        violations: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
} finally {
  await mkdir('dist/reports', { recursive: true });
  await writeFile(
    'dist/reports/a11y-check.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), routeResults }, null, 2)}\n`,
  );
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} route(s) have serious or critical accessibility violations.`);
}
