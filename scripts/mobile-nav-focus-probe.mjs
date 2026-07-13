import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable, seedThemeInitScript } from './a11y-helpers.mjs';

/* global document */

const REPORT_DIR = 'dist/reports/mobile-nav';
const ROUTES = [
  { id: 'host-today', path: '/today', expectedText: 'Today' },
  { id: 'lsat-srs', path: '/lsat/srs', expectedText: 'SRS' },
];

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before mobile-nav:probe.');
});
await mkdir(REPORT_DIR, { recursive: true });

function routeUrl(address, path) {
  return new URL(path, address).toString();
}

async function waitForBodyText(page, text, label) {
  await page
    .waitForFunction((expected) => document.body.innerText.includes(expected), text, { timeout: 20_000 })
    .catch((error) => {
      throw new Error(`Timed out waiting for ${label}: ${error.message}`);
    });
}

async function readDrawerState(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector('#main-sidebar');
    const button = document.querySelector('.mobile-menu-button');
    const active = document.activeElement;
    return {
      sidebarHidden: sidebar?.hasAttribute('hidden') ?? null,
      sidebarOpenClass: sidebar?.classList.contains('open') ?? false,
      sidebarContainsFocus: Boolean(sidebar && active && sidebar.contains(active)),
      menuHasFocus: button === active,
      expanded: button?.getAttribute('aria-expanded') ?? null,
      activeTag: active?.tagName ?? null,
      activeTitle: active?.getAttribute?.('title') ?? null,
      activeText: active?.textContent?.trim().slice(0, 120) ?? null,
    };
  });
}

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: false,
    open: false,
  },
});

const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error(
    'No Chromium-compatible browser found for mobile nav probe. Install Chrome/Edge, ' +
      'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium".',
  );
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4188/';
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await seedThemeInitScript(context, 'light');
const page = await context.newPage();
const results = [];
const failures = [];

try {
  for (const route of ROUTES) {
    const startedAt = Date.now();
    const url = routeUrl(address, route.path);
    const result = {
      id: route.id,
      path: route.path,
      url,
      viewport: { width: 390, height: 844 },
      status: 'ok',
      durationMs: 0,
    };

    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await waitForBodyText(page, route.expectedText, route.id);
      await page.locator('.mobile-menu-button').click();
      await page.waitForFunction(
        () => {
          const sidebar = document.querySelector('#main-sidebar');
          return sidebar && !sidebar.hasAttribute('hidden') && sidebar.contains(document.activeElement);
        },
        null,
        { timeout: 5_000 },
      );
      await page.waitForFunction(
        () => {
          const sidebar = document.querySelector('#main-sidebar');
          if (!sidebar) return false;
          return Math.abs(sidebar.getBoundingClientRect().left) < 1;
        },
        null,
        { timeout: 5_000 },
      );
      result.afterOpen = await readDrawerState(page);
      result.screenshotPath = join(REPORT_DIR, `${route.id}.png`);
      await page.screenshot({ path: result.screenshotPath, fullPage: true });
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => {
          const sidebar = document.querySelector('#main-sidebar');
          const button = document.querySelector('.mobile-menu-button');
          return sidebar?.hasAttribute('hidden') && button === document.activeElement && button?.getAttribute('aria-expanded') === 'false';
        },
        null,
        { timeout: 5_000 },
      );
      result.afterEscape = await readDrawerState(page);
      console.log(`OK mobile nav ${route.id}`);
    } catch (error) {
      result.status = 'blocked';
      result.error = error instanceof Error ? error.message : String(error);
      failures.push({ id: route.id, error: result.error });
      console.error(`FAIL mobile nav ${route.id}: ${result.error}`);
    } finally {
      result.durationMs = Date.now() - startedAt;
      results.push(result);
    }
  }
} finally {
  await writeFile(
    'dist/reports/mobile-nav-focus.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results, failures }, null, 2)}\n`,
  );
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  throw new Error(`${failures.length} mobile nav focus probe(s) failed.`);
}
