import { access } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { smokeRoutes as routes } from '../src/routes/routeManifest.ts';

/* global document */

const COLD_START_TIMEOUT_MS = 120_000;
const ROUTE_TIMEOUT_MS = 60_000;
const TEXT_TIMEOUT_MS = 30_000;

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

const server = await createServer({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: false,
  },
});
await server.listen();
const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:5173/';
const executablePath = await firstExistingPath(browserCandidates);
if (!executablePath) {
  await server.close();
  throw new Error('No local Chromium-compatible browser executable found for smoke tests.');
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  for (const [index, [route, expectedText]] of routes.entries()) {
    const url = new URL(route, address).toString();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: index === 0 ? COLD_START_TIMEOUT_MS : ROUTE_TIMEOUT_MS,
    });
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      expectedText,
      { timeout: TEXT_TIMEOUT_MS },
    );
    const body = await page.evaluate(() => document.body.innerText);
    if (!body.includes(expectedText)) {
      throw new Error(`Missing expected text "${expectedText}" at ${url}`);
    }
    if (/TypeError|ReferenceError|Cannot read|Failed to fetch/i.test(body)) {
      throw new Error(`Runtime error text detected at ${url}`);
    }
    console.log(`OK ${route}`);
  }
} finally {
  await browser.close();
  await server.close();
}
