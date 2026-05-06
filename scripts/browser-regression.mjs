import { access } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

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

async function waitForBodyText(page, pattern, label) {
  await page.waitForFunction(
    (source) => new RegExp(source, 'i').test(document.body.innerText),
    pattern.source,
    { timeout: 20_000 },
  ).catch((error) => {
    throw new Error(`Timed out waiting for ${label}: ${error.message}`);
  });
}

async function assertNoRuntimeErrors(page, label) {
  const body = await page.locator('body').innerText({ timeout: 10_000 });
  if (/TypeError|ReferenceError|Cannot read|Failed to fetch/i.test(body)) {
    throw new Error(`Runtime error text detected during ${label}`);
  }
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
  throw new Error('No local Chromium-compatible browser executable found for browser regression checks.');
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  await page.goto(new URL('/cfa/level2/equity/vignette', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /Equity Valuation/, 'Level II equity vignette content');
  await waitForBodyText(page, /EXAM-READY/, 'Level II exam-ready badge');
  const options = page.locator('.quiz-option');
  const optionCount = await options.count();
  if (optionCount < 4) throw new Error('Level II vignette did not render answer choices.');
  const questionCards = page.locator('.quiz-container .glass-card');
  const questionCardCount = await questionCards.count();
  for (let index = 0; index < questionCardCount; index += 1) {
    const firstOption = questionCards.nth(index).locator('.quiz-option').first();
    if ((await firstOption.count()) > 0) await firstOption.click();
  }
  await page.getByRole('button', { name: /submit vignette/i }).click();
  await waitForBodyText(page, /Next Vignette/, 'submitted Level II vignette');
  await assertNoRuntimeErrors(page, 'Level II vignette flow');
  console.log('OK Level II async vignette flow');

  await page.goto(new URL('/cfa/level2/mock', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /MOCK SECTION/, 'Level II mock section');
  await waitForBodyText(page, /EXAM-READY/, 'Level II mock exam-ready badge');
  const firstMockOption = page.locator('.quiz-option').first();
  if ((await firstMockOption.count()) === 0) throw new Error('Level II mock did not render a selectable item.');
  await firstMockOption.click();
  await page.getByRole('button', { name: /^pause$/i }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await waitForBodyText(page, /Section Paused|Resume/, 'mock resume after reload');
  await assertNoRuntimeErrors(page, 'mock resume flow');
  console.log('OK Level II mock resume flow');

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await waitForBodyText(page, /Offline/, 'offline app-shell badge');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  console.log('OK offline badge path');

  await page.evaluate(() => {
    window.__qvUpdateApplied = false;
    window.dispatchEvent(
      new CustomEvent('quantvault:pwa-update', {
        detail: {
          applyUpdate: () => {
            window.__qvUpdateApplied = true;
          },
        },
      }),
    );
  });
  await page.getByRole('button', { name: /update/i }).click();
  const updateApplied = await page.evaluate(() => window.__qvUpdateApplied);
  if (!updateApplied) throw new Error('PWA update prompt did not invoke applyUpdate.');
  console.log('OK PWA update prompt path');

  await page.goto(new URL('/system', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /Service Worker/, 'system service-worker surface');
  await assertNoRuntimeErrors(page, 'system health surface');
  console.log('OK system health surface');
} finally {
  await browser.close();
  await server.close();
}
