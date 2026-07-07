import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { appRoutes } from '../src/routes/routeManifest.ts';
import { applySourceState, browserCandidates, firstExistingPath, summarizeRouteFailures, viewports } from './qa-helpers.mjs';

/* global document, indexedDB, window */

async function waitForBodyText(page, pattern, label) {
  await page.waitForFunction(
    (source) => new RegExp(source, 'i').test(document.body.innerText),
    pattern.source,
    { timeout: 20_000 },
  ).catch((error) => {
    throw new Error(`Timed out waiting for ${label}: ${error.message}`);
  });
}

async function assertNoRuntimeErrors(page, label, { allowFetchFailureText = false } = {}) {
  const body = await page.locator('body').innerText({ timeout: 10_000 });
  const runtimePattern = allowFetchFailureText
    ? /TypeError|ReferenceError|Cannot read/i
    : /TypeError|ReferenceError|Cannot read|Failed to fetch/i;
  if (runtimePattern.test(body)) {
    throw new Error(`Runtime error text detected during ${label}`);
  }
}

async function readIndexedDbStoreCount(page, storeName) {
  return page.evaluate(async (store) => {
    const request = indexedDB.open('quantvault');
    const db = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const read = tx.objectStore(store).count();
        read.onerror = () => reject(read.error);
        read.onsuccess = () => resolve(read.result);
      });
    } finally {
      db.close();
    }
  }, storeName);
}

async function waitForIndexedDbStoreCountAbove(page, storeName, minimumCount, label) {
  const deadline = Date.now() + 10_000;
  let lastCount = -1;

  while (Date.now() < deadline) {
    try {
      lastCount = await readIndexedDbStoreCount(page, storeName);
      if (lastCount > minimumCount) return;
    } catch (error) {
      lastCount = error?.message || -1;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${label}; last ${storeName} count was ${lastCount}.`);
}

async function waitForMockSectionStatus(page, stateId, expectedStatus, label) {
  const deadline = Date.now() + 10_000;
  let lastStatus = 'not-read';

  while (Date.now() < deadline) {
    try {
      lastStatus = await page.evaluate(async (id) => {
        const request = indexedDB.open('quantvault');
        const db = await new Promise((resolve, reject) => {
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });

        try {
          const state = await new Promise((resolve, reject) => {
            const tx = db.transaction('mockSectionState', 'readonly');
            const read = tx.objectStore('mockSectionState').get(id);
            read.onerror = () => reject(read.error);
            read.onsuccess = () => resolve(read.result || null);
          });
          return state?.status || 'missing';
        } finally {
          db.close();
        }
      }, stateId);
      if (lastStatus === expectedStatus) return;
    } catch (error) {
      lastStatus = error?.message || 'read-error';
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${label}; last mock state status was ${lastStatus}.`);
}

async function waitForServiceWorkerReady(page, timeoutMs = 10_000) {
  return page.evaluate(async (timeout) => {
    if (!('serviceWorker' in navigator)) return false;
    const ready = navigator.serviceWorker.ready
      .then(() => Boolean(navigator.serviceWorker.controller))
      .catch(() => false);
    const timeoutResult = new Promise((resolve) => {
      window.setTimeout(() => resolve(false), timeout);
    });
    return Promise.race([ready, timeoutResult]);
  }, timeoutMs).catch(() => false);
}

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before browser:regression.');
});

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: false,
    open: false,
  },
});
const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4173/';
const executablePath = await firstExistingPath(browserCandidates);
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error('No local Chromium-compatible browser executable found for browser regression checks.');
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: viewports.desktop });
const routeResults = [];
let currentStep = null;
let currentStepStartedAt = Date.now();
let firstFailure = null;

function startBrowserStep(routeId, path, label) {
  currentStep = { routeId, path, label };
  currentStepStartedAt = Date.now();
}

function passBrowserStep() {
  if (!currentStep) return;
  routeResults.push({
    routeId: currentStep.routeId,
    path: currentStep.path,
    label: currentStep.label,
    sourceState: currentStep.sourceState || 'default',
    status: 'ok',
    durationMs: Date.now() - currentStepStartedAt,
  });
}

try {
  startBrowserStep('browser:cfa-vignette', '/cfa/level2/equity/vignette', 'Level II async vignette flow');
  await page.goto(new URL('/cfa/level2/equity/vignette', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /Equity Valuation/, 'Level II equity vignette content');
  await waitForBodyText(page, /LEVEL 2|LEVEL II/, 'Level II vignette level marker');
  const options = page.locator('.quiz-option');
  const optionCount = await options.count();
  if (optionCount < 4) throw new Error('Level II vignette did not render answer choices.');
  const questionCards = page.locator('.quiz-container .question-stage, .quiz-container .glass-card');
  const questionCardCount = await questionCards.count();
  for (let index = 0; index < questionCardCount; index += 1) {
    const firstOption = questionCards.nth(index).locator('.quiz-option').first();
    if ((await firstOption.count()) > 0) await firstOption.click();
  }
  await page.waitForFunction(
    (count) => document.querySelectorAll('.quiz-option.selected').length === count,
    questionCardCount,
    { timeout: 10_000 },
  );
  await page.getByRole('button', { name: /submit vignette/i }).click();
  await waitForBodyText(page, /Correct|Review/, 'submitted Level II vignette feedback');
  await assertNoRuntimeErrors(page, 'Level II vignette flow');
  passBrowserStep();
  console.log('OK Level II async vignette flow');

  startBrowserStep('browser:cfa-constructed-response', '/cfa/level3/performance/constructed-response', 'Level III constructed-response flow');
  await page.goto(new URL('/cfa/level3/performance/constructed-response', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /Performance Measurement/, 'Level III constructed-response content');
  await waitForBodyText(page, /LEVEL III RESPONSE/, 'Level III constructed-response shell');
  const constructedAttemptCount = await readIndexedDbStoreCount(page, 'constructedResponseAttempts');
  await page.getByLabel(/constructed response answer/i).fill('Recommend the monitoring action because the benchmark evidence controls the decision and the portfolio facts support a concise implementation response.');
  const scoreInputs = page.locator('.rubric-row input, .analytics-row input');
  const scoreInputCount = await scoreInputs.count();
  if (scoreInputCount < 3) throw new Error('Level III constructed-response rubric did not render scoring inputs.');
  for (let index = 0; index < scoreInputCount; index += 1) {
    await scoreInputs.nth(index).fill('1');
  }
  await page.waitForFunction(
    (count) => Array.from(document.querySelectorAll('.rubric-row input, .analytics-row input')).filter((input) => input.value).length === count,
    scoreInputCount,
    { timeout: 10_000 },
  );
  await page.getByRole('button', { name: /submit response/i }).click();
  await waitForBodyText(page, /Model Answer/, 'submitted Level III constructed response');
  await waitForIndexedDbStoreCountAbove(page, 'constructedResponseAttempts', constructedAttemptCount, 'persisted Level III constructed response');
  await assertNoRuntimeErrors(page, 'Level III constructed-response flow');
  passBrowserStep();
  console.log('OK Level III constructed-response flow');

  startBrowserStep('browser:cfa-mock-resume', '/cfa/level2/mock', 'Level II mock resume flow');
  await page.goto(new URL('/cfa/level2/mock', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /MOCK SECTION/, 'Level II mock section');
  await waitForBodyText(page, /Level II|LEVEL 2/, 'Level II mock level marker');
  await waitForMockSectionStatus(page, 'cfa-level2-mixed-mock', 'in-progress', 'initial mock persistence hydration');
  const firstMockOption = page.locator('.quiz-option').first();
  if ((await firstMockOption.count()) === 0) throw new Error('Level II mock did not render a selectable item.');
  await firstMockOption.click();
  await page.getByRole('button', { name: /^pause$/i }).click();
  await waitForBodyText(page, /Section Paused|Resume Section/, 'mock paused before reload');
  await waitForMockSectionStatus(page, 'cfa-level2-mixed-mock', 'paused', 'persisted mock pause state');
  await page.reload({ waitUntil: 'networkidle' });
  await waitForBodyText(page, /Section Paused|Resume/, 'mock resume after reload');
  await assertNoRuntimeErrors(page, 'mock resume flow');
  passBrowserStep();
  console.log('OK Level II mock resume flow');

  startBrowserStep('browser:offline-badge', '/cfa/level2/mock', 'offline badge path');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await waitForBodyText(page, /Offline/, 'offline app-shell badge');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  passBrowserStep();
  console.log('OK offline badge path');

  startBrowserStep('browser:offline-reload', '/', 'production offline reload');
  await page.goto(new URL('/', address).toString(), { waitUntil: 'networkidle' });
  let serviceWorkerReady = await waitForServiceWorkerReady(page);
  if (!serviceWorkerReady) {
    await page.reload({ waitUntil: 'networkidle' });
    serviceWorkerReady = await waitForServiceWorkerReady(page);
  }
  if (serviceWorkerReady) {
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBodyText(page, /StudyVault|QuantVault/, 'production offline reload');
    await page.context().setOffline(false);
    console.log('OK production offline reload');
  } else {
    throw new Error('Service worker did not become ready in production preview.');
  }
  passBrowserStep();

  const offlineMatrix = appRoutes
    .filter((route) => route.offlineCritical)
    .map((route) => ({
      id: route.id,
      path: route.smokeRoute || route.screenshotRoute || route.path,
      expectedText: route.expectedText,
    }));
  for (const route of offlineMatrix) {
    startBrowserStep(`browser:offline:${route.id}`, route.path, `offline deep route ${route.id}`);
    await page.context().setOffline(false);
    await page.goto(new URL(route.path, address).toString(), { waitUntil: 'networkidle' });
    await waitForBodyText(page, new RegExp(route.expectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `online warm ${route.id}`);
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBodyText(page, /QuantVault|Offline|CFA|System|Vault|Review|Flashcards|Mock/i, `offline deep route ${route.id}`);
    await page.context().setOffline(false);
    passBrowserStep();
    console.log(`OK offline deep route ${route.id}`);
  }

  startBrowserStep('browser:pwa-update', '/', 'PWA update prompt path');
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
  passBrowserStep();
  console.log('OK PWA update prompt path');

  startBrowserStep('browser:system-health', '/system', 'system health surface');
  await page.goto(new URL('/system', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /Service Worker/, 'system service-worker surface');
  await assertNoRuntimeErrors(page, 'system health surface', { allowFetchFailureText: true });
  passBrowserStep();
  console.log('OK system health surface');

  startBrowserStep('browser:vault-source-state', '/vault?sourceQuery=duration', 'synthetic source-vault browser hook');
  currentStep.sourceState = 'synthetic-source';
  await applySourceState(page, address, 'synthetic-source');
  await page.goto(new URL('/vault?sourceQuery=duration', address).toString(), { waitUntil: 'networkidle' });
  await waitForBodyText(page, /Synthetic Duration Guide/, 'synthetic source search result');
  await waitForBodyText(page, /private local only|standard vault exports omit source text/i, 'source privacy messaging');
  passBrowserStep();
  console.log('OK synthetic source-vault browser hook');
} catch (error) {
  if (currentStep) {
    routeResults.push({
      routeId: currentStep.routeId,
      path: currentStep.path,
      label: currentStep.label,
      sourceState: currentStep.sourceState || 'default',
      status: 'blocked',
      durationMs: Date.now() - currentStepStartedAt,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  firstFailure = error;
} finally {
  await mkdir('dist/reports', { recursive: true });
  await writeFile(
    'dist/reports/browser-regression.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), routeResults, routeFailures: summarizeRouteFailures(routeResults) }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (firstFailure) throw firstFailure;
