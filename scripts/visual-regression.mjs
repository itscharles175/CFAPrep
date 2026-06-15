/*
 * UA7 — design-token visual-regression net.
 *
 * Screenshots a CURATED set of routes (including the /style token gallery) in
 * BOTH the light and dark themes AND BOTH the desktop + mobile viewports, then
 * pixel-diffs each frame against a committed baseline. The goal is a cheap drift
 * alarm for the design system: if a token, primitive, or layout shifts
 * unintentionally, the matching baseline stops matching and CI fails.
 *
 * K4-0 — the gate now varies the VIEWPORT (desktop + mobile) per route, not just
 * the theme, so a responsive regression is caught on both layouts (the K4 UI
 * unification needs a mobile-parity net). It also reads BOTH route manifests —
 * the host `screenshotRoutes` and the vendored LSAT `lsatScreenshotRoutes`
 * (derived from src/domains/lsat/lib/routeManifest.ts) — so the /lsat/* surface
 * can be crawled. LSAT routes are opt-in via INCLUDE_LSAT_ROUTES=1 (the
 * dedicated `lsat-qa-gates` CI job sets it; see scripts/qa-helpers.mjs), keeping
 * the host `visual` job's baseline set unchanged by default.
 *
 * MECHANISM (mirrors scripts/a11y-check.mjs so the two gates share their patterns):
 *   - SERVE: `vite preview` over the production `dist/` build (run `npm run build`
 *     first). Same preview-server lifecycle as the a11y gate.
 *   - BROWSER: resolveBrowserExecutable() — a system Chrome/Edge if present, else
 *     the Playwright-managed Chromium from `npx playwright install chromium`
 *     (chromium.executablePath()). Identical resolution order to a11y-helpers.
 *   - THEME: seedThemeInitScript() seeds localStorage['qv-theme'] via addInitScript
 *     BEFORE first paint, so the app's synchronous bootstrap applies the matching
 *     `data-theme` with no flash. A fresh context per theme isolates the seed.
 *
 * BASELINES (committed): tests/visual-baselines/<route>-<theme>-<viewport>.png.
 *   - When a baseline EXISTS, the new frame is compared with pixelmatch at a small
 *     per-pixel tolerance; the run fails if the changed-pixel RATIO exceeds
 *     DIFF_RATIO_TOLERANCE (a tiny anti-aliasing/subpixel budget). A `*-diff.png`
 *     highlighting the changed pixels is written next to the screenshot for review.
 *   - When NO baseline exists, the frame is WRITTEN as the new baseline and the
 *     check passes (bootstrap). Commit tests/visual-baselines/ to lock it in.
 *   - When dimensions differ from the baseline, that is treated as a failure
 *     (a layout/viewport change must be reviewed + re-baselined deliberately).
 *
 * REPORT: dist/reports/visual/*.png (screenshots + diffs) and
 *   dist/reports/visual-regression.json (machine-readable result). `dist/` is
 *   gitignored, so report artifacts never enter git; baselines under tests/ do.
 *
 * NPM-FREE INVOCATION (no npm script needed):
 *   1. node scripts/build... — actually: build once, then run this with the
 *      TS loader so the `.ts` route manifest import resolves:
 *        node --import ./scripts/register-ts-loader.mjs scripts/visual-regression.mjs
 *      (this is exactly what `npm run visual:regression` wraps).
 *   To intentionally re-baseline after an approved visual change, delete the stale
 *   PNGs under tests/visual-baselines/ (or pass UPDATE_VISUAL_BASELINES=1) and rerun.
 *
 * Uses pixelmatch + pngjs, both already devDependencies (shared with the existing
 * QA tooling) — no new package is added.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { lsatScreenshotRoutes, screenshotRoutes } from '../src/routes/routeManifest.ts';
import { resolveBrowserExecutable, seedThemeInitScript } from './a11y-helpers.mjs';
import { includeLsatRoutes, lsatRoutesOnly, selectGateRoutes, viewports } from './qa-helpers.mjs';

/* global document */

const BASELINE_DIR = 'tests/visual-baselines';
const REPORT_DIR = 'dist/reports/visual';
const UPDATE_BASELINES = process.env.UPDATE_VISUAL_BASELINES === '1';

// Per-pixel color tolerance handed to pixelmatch (0 = exact, 1 = anything). A
// small value absorbs sub-pixel anti-aliasing without masking real token shifts.
const PIXEL_THRESHOLD = 0.1;
// Fraction of changed pixels the whole frame is allowed before it counts as a
// regression. Tiny by design — font hinting differences across machines are
// well under this, but a recolored surface or moved component blows past it.
const DIFF_RATIO_TOLERANCE = 0.012;

const THEMES = ['dark', 'light'];

// K4-0 — every route is now captured at BOTH viewports (was desktop-only). The
// names index into `viewports` (qa-helpers); a fresh context is opened per
// viewport so the seeded theme + the deterministic device metrics apply before
// first paint.
const VIEWPORT_NAMES = ['desktop', 'mobile'];

// Curated, deterministic HOST surfaces. /style is the token gallery (the richest
// single surface for design drift); the rest are stable, data-light routes that
// render fully offline with no seeded fixtures, so their frames stay reproducible.
// The dashboard (/) is intentionally excluded: its first-run onboarding overlay
// makes the frame non-deterministic. Paths + expectedText are sourced from the
// canonical routeManifest (the same `screenshotRoutes` the a11y gate uses), so
// the two gates never drift on what each route renders.
const CURATED_ROUTE_IDS = ['style', 'cfa-dashboard', 'analytics', 'system', 'today'];

const routeById = new Map(screenshotRoutes.map((route) => [route.id, route]));
const HOST_ROUTES = CURATED_ROUTE_IDS.map((id) => {
  const route = routeById.get(id);
  if (!route) throw new Error(`Curated visual route "${id}" is not in screenshotRoutes (routeManifest.ts).`);
  return { id: route.id, path: route.path, expectedText: route.expectedText };
});

// K4-0 — the LSAT manifest's surface (opt-in via INCLUDE_LSAT_ROUTES=1). Every
// derived LSAT route already carries a deterministic `expectedText` anchor, so
// the whole set is eligible (no per-route curation list needed here).
const LSAT_ROUTES = lsatScreenshotRoutes.map((route) => ({
  id: route.id,
  path: route.path,
  expectedText: route.expectedText,
}));

// Host-only by default; host ∪ LSAT (or LSAT-only) when the flags are set.
const TARGET_ROUTES = selectGateRoutes(HOST_ROUTES, LSAT_ROUTES);

async function waitForBodyText(page, text, label) {
  await page
    .waitForFunction((expected) => document.body.innerText.includes(expected), text, { timeout: 20_000 })
    .catch((error) => {
      throw new Error(`Timed out waiting for ${label}: ${error.message}`);
    });
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare a freshly captured PNG buffer against a committed baseline.
 *
 * Returns one of:
 *   { outcome: 'bootstrapped' }     — no baseline existed; it was written.
 *   { outcome: 'updated' }          — UPDATE_VISUAL_BASELINES rewrote it.
 *   { outcome: 'match', ratio }     — within tolerance.
 *   { outcome: 'diff', ratio, ... } — over tolerance (or size mismatch); fails.
 */
async function compareToBaseline({ id, theme, viewport, screenshot }) {
  const name = `${id}-${theme}-${viewport}`;
  const baselinePath = join(BASELINE_DIR, `${name}.png`);
  const screenshotPath = join(REPORT_DIR, `${name}.png`);
  await writeFile(screenshotPath, screenshot);

  const hasBaseline = await fileExists(baselinePath);
  if (!hasBaseline || UPDATE_BASELINES) {
    await writeFile(baselinePath, screenshot);
    return { outcome: hasBaseline ? 'updated' : 'bootstrapped', name, baselinePath, screenshotPath };
  }

  const baselineBuffer = await readFile(baselinePath);
  const baseline = PNG.sync.read(baselineBuffer);
  const current = PNG.sync.read(screenshot);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      outcome: 'diff',
      name,
      baselinePath,
      screenshotPath,
      reason: `dimensions changed (baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height})`,
      ratio: 1,
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const changed = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, {
    threshold: PIXEL_THRESHOLD,
  });
  const ratio = changed / (baseline.width * baseline.height);

  if (ratio > DIFF_RATIO_TOLERANCE) {
    const diffPath = join(REPORT_DIR, `${name}-diff.png`);
    await writeFile(diffPath, PNG.sync.write(diff));
    return { outcome: 'diff', name, baselinePath, screenshotPath, diffPath, ratio, changedPixels: changed };
  }

  return { outcome: 'match', name, baselinePath, screenshotPath, ratio, changedPixels: changed };
}

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before visual:regression.');
});

await mkdir(BASELINE_DIR, { recursive: true });
await mkdir(REPORT_DIR, { recursive: true });

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4176,
    strictPort: false,
    open: false,
  },
});

const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error(
    'No Chromium-compatible browser found for visual regression. Install a system Chrome/Edge, ' +
      'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium" (CI does this).',
  );
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4176/';
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
const failures = [];

// A fresh context per (theme, viewport) isolates the seeded localStorage['qv-theme']
// so the bootstrap applies the right `data-theme` before first paint (no theme
// bleed), and pins the device metrics so the frame is captured at exactly the
// target viewport (mobile uses 390x844; see qa-helpers `viewports`).
async function withThemeViewportContext(theme, viewportName, run) {
  const context = await browser.newContext({ viewport: viewports[viewportName] });
  await seedThemeInitScript(context, theme);
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

try {
  for (const theme of THEMES) {
    for (const viewportName of VIEWPORT_NAMES) {
      await withThemeViewportContext(theme, viewportName, async (page) => {
        await page.setViewportSize(viewports[viewportName]);
        for (const route of TARGET_ROUTES) {
          const startedAt = Date.now();
          const url = new URL(route.path, address).toString();
          const scope = `${route.id} [${theme}/${viewportName}]`;
          try {
            await page.goto(url, { waitUntil: 'networkidle' });
            await waitForBodyText(page, route.expectedText, scope);
            // Let fonts settle + any entrance transitions finish so the frame is
            // deterministic; the app honours prefers-reduced-motion but headless
            // Chromium does not assert it, so a short settle still matters.
            await page.waitForTimeout(1200);
            const screenshot = await page.screenshot({ fullPage: false });
            const result = await compareToBaseline({ id: route.id, theme, viewport: viewportName, screenshot });
            results.push({ ...result, routeId: route.id, theme, viewport: viewportName, path: route.path, url, durationMs: Date.now() - startedAt });
            if (result.outcome === 'diff') {
              failures.push({
                scope,
                reason: result.reason || `pixel diff ${(result.ratio * 100).toFixed(3)}% > tolerance ${(DIFF_RATIO_TOLERANCE * 100).toFixed(3)}%`,
                diffPath: result.diffPath,
              });
              console.error(`DIFF visual ${scope} — ${result.reason || `${(result.ratio * 100).toFixed(3)}% changed`}`);
            } else if (result.outcome === 'bootstrapped') {
              console.log(`NEW baseline visual ${scope} (bootstrapped)`);
            } else if (result.outcome === 'updated') {
              console.log(`UPDATED baseline visual ${scope}`);
            } else {
              console.log(`OK visual ${scope} (${(result.ratio * 100).toFixed(3)}% changed)`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ scope, reason: message });
            results.push({ outcome: 'error', routeId: route.id, theme, viewport: viewportName, path: route.path, url, reason: message, durationMs: Date.now() - startedAt });
            console.error(`ERROR visual ${scope} — ${message}`);
          }
        }
      });
    }
  }
} finally {
  await writeFile(
    'dist/reports/visual-regression.json',
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        themes: THEMES,
        viewports: VIEWPORT_NAMES,
        includeLsatRoutes,
        lsatRoutesOnly,
        routeCount: TARGET_ROUTES.length,
        baselineDir: BASELINE_DIR,
        reportDir: REPORT_DIR,
        diffRatioTolerance: DIFF_RATIO_TOLERANCE,
        pixelThreshold: PIXEL_THRESHOLD,
        updateBaselines: UPDATE_BASELINES,
        results,
        failures,
      },
      null,
      2,
    )}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(
    `${failures.length} visual-regression check(s) failed. Review dist/reports/visual/*-diff.png; ` +
      'if the change is intentional, delete the stale tests/visual-baselines/*.png (or set ' +
      'UPDATE_VISUAL_BASELINES=1) and rerun to re-baseline.',
  );
}
