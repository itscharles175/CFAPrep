import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { screenshotRoutes } from '../src/routes/routeManifest.ts';

/* global document, window */

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

const viewports = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};

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

function assertNonBlankScreenshot(buffer, label) {
  const image = PNG.sync.read(buffer);
  const baseline = new PNG({ width: image.width, height: image.height });
  const diff = new PNG({ width: image.width, height: image.height });
  const first = image.data.slice(0, 4);
  for (let index = 0; index < baseline.data.length; index += 4) {
    baseline.data[index] = first[0];
    baseline.data[index + 1] = first[1];
    baseline.data[index + 2] = first[2];
    baseline.data[index + 3] = first[3];
  }
  const mismatch = pixelmatch(image.data, baseline.data, diff.data, image.width, image.height, { threshold: 0.12 });
  const ratio = mismatch / (image.width * image.height);
  if (ratio < 0.01) throw new Error(`${label} rendered as a nearly blank single-color frame.`);
}

async function assertNoObviousLayoutBreaks(page, label) {
  const issues = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const geometryIssues = Array.from(document.querySelectorAll('body *'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const hiddenMobileSidebar = viewportWidth <= 640 && element.closest('.sidebar') && !element.closest('.sidebar.open');
        const formulaInternal = element.closest('.formula-block, .formula-card, .katex');
        if (hiddenMobileSidebar) return false;
        if (formulaInternal) return false;
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -2 || rect.right > viewportWidth + 2;
      })
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).replace(/\s+/g, '.')}`);

    const textOverflowIssues = Array.from(document.querySelectorAll('button, .btn, .segmented-tab, .status-badge, .badge'))
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .slice(0, 5)
      .map((element) => element.textContent?.trim() || element.tagName.toLowerCase());

    return [...geometryIssues, ...textOverflowIssues];
  });

  if (issues.length) {
    throw new Error(`${label} has visible overflow: ${issues.join(', ')}`);
  }
}

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before visual:regression.');
});

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: false,
    open: false,
  },
});

const executablePath = await firstExistingPath(browserCandidates);
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error('No local Chromium-compatible browser executable found for visual regression checks.');
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4174/';
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
const routeResults = [];
let firstFailure = null;

try {
  for (const route of screenshotRoutes) {
    for (const viewportName of route.viewports) {
      const startedAt = Date.now();
      try {
        await page.setViewportSize(viewports[viewportName]);
        const url = new URL(route.path, address).toString();
        await page.goto(url, { waitUntil: 'networkidle' });
        await waitForBodyText(page, route.expectedText, `${route.id} ${viewportName}`);
        await assertNoObviousLayoutBreaks(page, `${route.id} ${viewportName}`);
        const screenshot = await page.screenshot({ fullPage: false });
        assertNonBlankScreenshot(screenshot, `${route.id} ${viewportName}`);
        routeResults.push({ routeId: route.id, path: route.path, viewport: viewportName, status: 'ok', durationMs: Date.now() - startedAt });
        console.log(`OK visual ${route.id} ${viewportName}`);
      } catch (error) {
        routeResults.push({
          routeId: route.id,
          path: route.path,
          viewport: viewportName,
          status: 'blocked',
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        });
        firstFailure ||= error;
      }
    }
  }
} finally {
  await mkdir('dist/reports', { recursive: true });
  await writeFile(
    'dist/reports/visual-regression.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), routeResults }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (firstFailure) throw firstFailure;
