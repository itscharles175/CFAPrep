import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable, seedThemeInitScript } from './a11y-helpers.mjs';

/* global document, getComputedStyle, HTMLElement, location, window */

const REPORT_PATH = 'dist/reports/keyboard-flow.json';
const SCREENSHOT_DIR = 'dist/reports/keyboard-flow';
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

const SKIP_LINK_CASES = [
  { id: 'host-today', path: '/today', expectedText: 'Today' },
  { id: 'lsat-srs', path: '/lsat/srs', expectedText: 'SRS' },
];

const TAB_SWEEP_CASES = [
  { id: 'host-today', path: '/today', expectedText: 'Today', steps: 8 },
  { id: 'lsat-bank', path: '/lsat/bank', expectedText: 'Question bank', steps: 10 },
];

const MOBILE_DRAWER_CASES = [
  { id: 'host-today', path: '/today', expectedText: 'Today' },
  { id: 'lsat-srs', path: '/lsat/srs', expectedText: 'SRS' },
];

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before a11y:keyboard.');
});
await mkdir(SCREENSHOT_DIR, { recursive: true });

function routeUrl(address, path) {
  return new URL(path, address).toString();
}

async function prepareContext(context, theme) {
  await seedThemeInitScript(context, theme);
  await context.addInitScript(() => {
    localStorage.setItem('qv-onboarding-dismissed-unified', '1');
    localStorage.setItem('lsatlab.onboardingDone', 'true');
  });
  await context.route(/\/api\//, (route) => route.abort('failed'));
}

async function waitForBodyText(page, text, label) {
  await page
    .waitForFunction((expected) => document.body.innerText.includes(expected), text, { timeout: 20_000 })
    .catch((error) => {
      throw new Error(`Timed out waiting for ${label}: ${error.message}`);
    });
}

async function activeElementInfo(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return { ok: false, reason: 'active element is not an HTMLElement' };
    }
    const rect = active.getBoundingClientRect();
    const style = getComputedStyle(active);
    const hasOutline = style.outlineStyle !== 'none' && style.outlineWidth !== '0px';
    const hasBoxShadow = style.boxShadow !== 'none';
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';

    return {
      ok: true,
      tag: active.tagName.toLowerCase(),
      id: active.id || null,
      className: typeof active.className === 'string' ? active.className : '',
      role: active.getAttribute('role'),
      ariaLabel: active.getAttribute('aria-label'),
      text: active.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) || '',
      visible,
      focusVisible: active.matches(':focus-visible'),
      hasFocusIndicator: hasOutline || hasBoxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
}

function failIfBadFocus(info, label) {
  if (!info.ok) throw new Error(`${label}: ${info.reason}`);
  if (!info.visible) {
    throw new Error(`${label}: active element is not visibly in viewport (${JSON.stringify(info)})`);
  }
  if (!info.focusVisible) {
    throw new Error(`${label}: active element does not match :focus-visible (${JSON.stringify(info)})`);
  }
  if (!info.hasFocusIndicator) {
    throw new Error(`${label}: active element has no computed outline or ring (${JSON.stringify(info)})`);
  }
}

async function assertSkipLink(page, address, route) {
  await page.goto(routeUrl(address, route.path), { waitUntil: 'networkidle' });
  await waitForBodyText(page, route.expectedText, route.id);
  await page.keyboard.press('Tab');
  const focusedSkip = await activeElementInfo(page);
  failIfBadFocus(focusedSkip, `${route.id} skip link`);
  if (!/skip to main content/i.test(focusedSkip.text)) {
    throw new Error(`${route.id}: first Tab did not focus the skip link (${JSON.stringify(focusedSkip)})`);
  }
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.activeElement?.id === 'main' && location.hash === '#main',
    null,
    { timeout: 5_000 },
  );
  const focusedMain = await activeElementInfo(page);
  return { focusedSkip, focusedMain };
}

async function assertTabSweep(page, address, route) {
  await page.goto(routeUrl(address, route.path), { waitUntil: 'networkidle' });
  await waitForBodyText(page, route.expectedText, route.id);
  const stops = [];
  for (let step = 1; step <= route.steps; step += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(40);
    const info = await activeElementInfo(page);
    failIfBadFocus(info, `${route.id} tab stop ${step}`);
    if (info.tag === 'body') {
      throw new Error(`${route.id} tab stop ${step}: focus escaped to body`);
    }
    stops.push({ step, ...info });
  }
  return { stops };
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
      activeText: active?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) ?? null,
      activeAriaLabel: active?.getAttribute?.('aria-label') ?? null,
    };
  });
}

async function assertMobileDrawer(page, address, route) {
  await page.goto(routeUrl(address, route.path), { waitUntil: 'networkidle' });
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
  const afterOpen = await readDrawerState(page);
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${route.id}-mobile-drawer.png`), fullPage: true });
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
  const afterEscape = await readDrawerState(page);
  return { afterOpen, afterEscape };
}

async function assertLsatRunnerKeyboard(page, address) {
  await page.goto(routeUrl(address, '/lsat/take/11?preset=skip'), { waitUntil: 'networkidle' });
  await waitForBodyText(page, 'Question 1 of', 'LSAT runner');
  await page.getByRole('radiogroup', { name: /answer choices/i }).waitFor({ timeout: 15_000 });
  const radios = page.getByRole('radio');
  const firstRadio = radios.first();
  await firstRadio.waitFor({ timeout: 5_000 });

  await page.keyboard.press('A');
  await page.waitForFunction(() => document.querySelector('[role="radio"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 5_000 });
  const afterSelect = await firstRadio.getAttribute('aria-checked');

  await page.keyboard.press('F');
  const flaggedButton = page.getByRole('button', { name: /^Flagged$/ });
  await flaggedButton.waitFor({ timeout: 5_000 });
  const afterFlag = await flaggedButton.textContent();

  await page.keyboard.press('ArrowRight');
  await waitForBodyText(page, 'Q 2 of', 'LSAT runner next question');
  const afterNext = await page.locator('body').evaluate((body) => body.innerText.match(/Q\s+\d+\s+of\s+\d+/)?.[0] ?? null);

  await page.keyboard.press('ArrowLeft');
  await waitForBodyText(page, 'Q 1 of', 'LSAT runner previous question');
  const afterPrev = await page.locator('body').evaluate((body) => body.innerText.match(/Q\s+\d+\s+of\s+\d+/)?.[0] ?? null);

  return { afterSelect, afterFlag: afterFlag?.trim() ?? null, afterNext, afterPrev };
}

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4191,
    strictPort: false,
    open: false,
  },
});

const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error(
    'No Chromium-compatible browser found for keyboard-flow probe. Install Chrome/Edge, ' +
      'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium".',
  );
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4191/';
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
const failures = [];

async function runCase(kind, id, fn) {
  const startedAt = Date.now();
  const result = { kind, id, status: 'ok', durationMs: 0 };
  try {
    Object.assign(result, await fn());
    console.log(`OK keyboard ${kind} ${id}`);
  } catch (error) {
    result.status = 'blocked';
    result.error = error instanceof Error ? error.message : String(error);
    failures.push({ kind, id, error: result.error });
    console.error(`FAIL keyboard ${kind} ${id}: ${result.error}`);
  } finally {
    result.durationMs = Date.now() - startedAt;
    results.push(result);
  }
}

try {
  const desktopContext = await browser.newContext({ viewport: DESKTOP });
  await prepareContext(desktopContext, 'light');
  const desktopPage = await desktopContext.newPage();
  try {
    for (const route of SKIP_LINK_CASES) {
      await runCase('skip-link', route.id, () => assertSkipLink(desktopPage, address, route));
    }
    for (const route of TAB_SWEEP_CASES) {
      await runCase('tab-sweep', route.id, () => assertTabSweep(desktopPage, address, route));
    }
    await runCase('lsat-runner', 'sample-section-shortcuts', () => assertLsatRunnerKeyboard(desktopPage, address));
  } finally {
    await desktopContext.close();
  }

  const mobileContext = await browser.newContext({ viewport: MOBILE, isMobile: true });
  await prepareContext(mobileContext, 'light');
  const mobilePage = await mobileContext.newPage();
  try {
    for (const route of MOBILE_DRAWER_CASES) {
      await runCase('mobile-drawer', route.id, () => assertMobileDrawer(mobilePage, address, route));
    }
  } finally {
    await mobileContext.close();
  }
} finally {
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), address, lsatApiMode: 'forced-offline-sample', results, failures }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  throw new Error(`${failures.length} keyboard-flow probe(s) failed. See ${REPORT_PATH}.`);
}
