import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from './a11y-helpers.mjs';

/* global document, getComputedStyle, window */

const REPORT_PATH = 'dist/reports/lsat-scroll-contract.json';
const VIEWPORTS = [
  { id: 'desktop-960', width: 960, height: 640, isMobile: false },
  { id: 'mobile-390', width: 390, height: 844, isMobile: true },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before lsat:scroll:contract.');
});
await mkdir('dist/reports', { recursive: true });

const server = await preview({
  preview: { host: '127.0.0.1', port: 4182, strictPort: false, open: false },
});
const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error('No Chromium-compatible browser found for the LSAT scroll contract.');
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4182/';
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
let failure = null;

try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, isMobile: viewport.isMobile });
    const page = await context.newPage();
    const result = { viewport: viewport.id, status: 'ok' };

    try {
      await page.goto(new URL('/lsat/practice', address).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('[data-app-root] .lsat-main-scroll-area', { timeout: 20_000 });
      result.geometry = await page.evaluate(() => {
        const main = document.querySelector('.main-content');
        const root = document.querySelector('[data-app-root]');
        const scroll = document.querySelector('.lsat-main-scroll-area');
        if (!main || !root || !scroll) throw new Error('LSAT scroll contract nodes are missing.');

        const describe = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            top: rect.top,
            bottom: rect.bottom,
            overflowY: getComputedStyle(element).overflowY,
          };
        };

        scroll.scrollTop = Number.MAX_SAFE_INTEGER;
        return {
          viewport: { height: window.innerHeight, documentHeight: document.documentElement.scrollHeight },
          main: describe(main),
          root: describe(root),
          scroll: describe(scroll),
          windowScrollY: window.scrollY,
          innerScrollTop: scroll.scrollTop,
        };
      });

      const { geometry } = result;
      assert(geometry.viewport.documentHeight <= geometry.viewport.height + 1, 'Document owns vertical overflow.');
      assert(geometry.main.scrollHeight <= geometry.main.clientHeight + 1, 'Host main content owns vertical overflow.');
      assert(geometry.root.scrollHeight <= geometry.root.clientHeight + 1, 'LSAT app root owns vertical overflow.');
      assert(geometry.main.top >= -1 && geometry.main.bottom <= geometry.viewport.height + 1, 'Host scrollport escapes the viewport.');
      assert(geometry.root.top >= -1 && geometry.root.bottom <= geometry.viewport.height + 1, 'LSAT app root escapes the viewport.');
      assert(geometry.scroll.top >= -1 && geometry.scroll.bottom <= geometry.viewport.height + 1, 'LSAT scroll region escapes the viewport.');
      assert(geometry.scroll.overflowY === 'auto', 'LSAT main region is not the vertical scroll owner.');
      assert(geometry.windowScrollY === 0, 'Scrolling LSAT content moved the document.');
      if (geometry.scroll.scrollHeight > geometry.scroll.clientHeight + 1) {
        assert(geometry.innerScrollTop > 0, 'Overflowing LSAT content cannot scroll inside its own region.');
      }
    } catch (error) {
      result.status = 'blocked';
      result.error = error instanceof Error ? error.message : String(error);
      failure ??= new Error(`${viewport.id}: ${result.error}`);
    } finally {
      results.push(result);
      await context.close();
    }
  }
} finally {
  await writeFile(REPORT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failure) throw failure;
