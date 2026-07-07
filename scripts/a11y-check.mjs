import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { lsatScreenshotRoutes, screenshotRoutes } from '../src/routes/routeManifest.ts';
import {
  applySourceState,
  routePathForSourceState,
  routeSourceStates,
  selectGateRoutes,
  summarizeRouteFailures,
  viewports,
} from './qa-helpers.mjs';
import {
  a11yThemes,
  contrastMatrix,
  preferenceMediaMatrix,
  resolveBrowserExecutable,
  seedThemeInitScript,
} from './a11y-helpers.mjs';

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

const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error(
    'No Chromium-compatible browser found for accessibility checks. Install a system Chrome/Edge, ' +
      'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium" (CI does this).',
  );
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4175/';
const browser = await chromium.launch({ executablePath, headless: true });

// QA-1 / K4-0 — the routes Pass 1 sweeps. Host `screenshotRoutes` by default;
// host ∪ LSAT (or LSAT-only) when INCLUDE_LSAT_ROUTES / LSAT_ROUTES_ONLY are set
// (the dedicated `lsat-qa-gates` CI job). Both lists share the shape this gate
// reads (id, path, expectedText, viewports), so the sweep is uniform — LSAT
// routes get `routeSourceStates(route)` → ['default'] (their ids aren't in the
// vault/cfa special-cased sets) and both viewports from `route.viewports`.
const gateRoutes = selectGateRoutes(screenshotRoutes, lsatScreenshotRoutes);

const failures = [];
const routeResults = [];
const contrastResults = [];
const preferenceResults = [];

function formatViolationNodes(violations) {
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => {
      const target = (node.target || []).join(' ') || '<unknown target>';
      const summary = (node.failureSummary || violation.help).replace(/\s+/g, ' ').trim();
      return `${violation.id}: ${target} — ${summary}`;
    }),
  );
}

function hasVisibleOutline(snapshot) {
  if (!snapshot?.focus) return false;
  const width = Number.parseFloat(snapshot.focus.outlineWidth || '0');
  return snapshot.focus.outlineStyle !== 'none' && width >= 2;
}

function assertPreferenceSnapshot(snapshot, scope, scenario) {
  const problems = [];
  if (!snapshot.contrastMore) {
    problems.push('prefers-contrast: more was not active');
  }
  if (scenario === 'forced-colors') {
    if (!snapshot.forcedColorsActive) problems.push('forced-colors: active was not active');
    if (snapshot.rootForcedColors !== 'active') {
      problems.push(`root --a11y-forced-colors was ${snapshot.rootForcedColors || '<empty>'}`);
    }
    if (!hasVisibleOutline(snapshot)) {
      problems.push(`focused control has no 2px+ outline (${JSON.stringify(snapshot.focus)})`);
    }
    if (snapshot.focus?.boxShadow && snapshot.focus.boxShadow !== 'none') {
      problems.push(`focused control still relies on box-shadow (${snapshot.focus.boxShadow})`);
    }
    if (snapshot.surface && snapshot.surface.boxShadow !== 'none') {
      problems.push(`surface still casts a shadow in forced-colors (${snapshot.surface.boxShadow})`);
    }
    if (snapshot.forcedColorAdjustNone?.length) {
      problems.push(`interactive forced-color-adjust:none found: ${snapshot.forcedColorAdjustNone.join(', ')}`);
    }
  } else if (snapshot.rootContrastMode !== 'more') {
    problems.push(`root --a11y-contrast-mode was ${snapshot.rootContrastMode || '<empty>'}`);
  }
  if (!snapshot.body || snapshot.body.color === snapshot.body.backgroundColor) {
    problems.push(`body foreground/background collapsed (${JSON.stringify(snapshot.body)})`);
  }
  if (snapshot.surface && snapshot.surface.borderTopStyle === 'none') {
    problems.push(`sample surface has no border style (${JSON.stringify(snapshot.surface)})`);
  }
  if (snapshot.chart && snapshot.chart.opacity === '0') {
    problems.push(`chart sample is transparent (${JSON.stringify(snapshot.chart)})`);
  }
  if (problems.length) {
    throw new Error(`${scope}: ${problems.join('; ')}`);
  }
}

async function collectPreferenceSnapshot(page, entry) {
  return page.evaluate(({ focusSelector, surfaceSelector, chartSelector }) => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const styleSummary = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        selector: el.tagName.toLowerCase(),
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderTopColor: style.borderTopColor,
        borderTopStyle: style.borderTopStyle,
        borderTopWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        forcedColorAdjust: style.forcedColorAdjust,
        opacity: style.opacity,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    };
    const firstVisible = (selector) => {
      if (!selector) return null;
      return Array.from(document.querySelectorAll(selector)).find(visible) || null;
    };
    const focusTarget = firstVisible(
      focusSelector || 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusTarget instanceof HTMLElement) {
      focusTarget.focus({ preventScroll: true });
    }
    const surface = firstVisible(surfaceSelector);
    const chart = firstVisible(chartSelector || 'svg path, svg line, svg text, [data-heatmap-root] [role="img"]');
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const interactives = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'),
    ).filter(visible).slice(0, 40);
    const forcedColorAdjustNone = interactives
      .filter((el) => getComputedStyle(el).forcedColorAdjust === 'none')
      .map((el) => {
        const name = el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName.toLowerCase();
        return String(name).replace(/\s+/g, ' ').slice(0, 80);
      });
    return {
      forcedColorsActive: window.matchMedia('(forced-colors: active)').matches,
      contrastMore: window.matchMedia('(prefers-contrast: more)').matches,
      rootContrastMode: root.getPropertyValue('--a11y-contrast-mode').trim(),
      rootForcedColors: root.getPropertyValue('--a11y-forced-colors').trim(),
      body: {
        color: body.color,
        backgroundColor: body.backgroundColor,
      },
      focus: styleSummary(focusTarget),
      surface: styleSummary(surface),
      chart: styleSummary(chart),
      forcedColorAdjustNone,
    };
  }, entry);
}

// A fresh context per theme so the seeded `localStorage['qv-theme']` (and thus
// the bootstrap's `data-theme`) is isolated and applied before first paint.
async function withThemeContext(theme, run) {
  const context = await browser.newContext({ viewport: viewports.desktop });
  await seedThemeInitScript(context, theme);
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

try {
  // ── Pass 1: broad WCAG 2.1 A/AA scan across every screenshot route, in BOTH
  // themes and BOTH viewports. Fails on serious/critical violations (matching
  // the prior gate's threshold) so existing route coverage is unchanged beyond
  // now also covering the light palette.
  for (const theme of a11yThemes) {
    await withThemeContext(theme, async (page) => {
      for (const route of gateRoutes) {
        for (const sourceState of routeSourceStates(route)) {
          for (const viewportName of route.viewports) {
            const startedAt = Date.now();
            const path = routePathForSourceState(route, sourceState);
            const url = new URL(path, address).toString();
            const scope = `${route.id} ${viewportName} ${sourceState} [${theme}]`;
            try {
              await page.setViewportSize(viewports[viewportName]);
              await applySourceState(page, address, sourceState);
              await page.goto(url, { waitUntil: 'networkidle' });
              await waitForBodyText(page, route.expectedText, scope);
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
                theme,
                status: violations.length ? 'blocked' : 'ok',
                durationMs: Date.now() - startedAt,
                url,
                violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
              });
              if (violations.length) {
                failures.push({
                  route: scope,
                  violations: violations.map((violation) => `${violation.id}: ${violation.help}`),
                });
              }
              console.log(`OK a11y scanned ${scope}`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              failures.push({ route: scope, violations: [message] });
              routeResults.push({
                routeId: route.id,
                path,
                expectedText: route.expectedText,
                viewport: viewportName,
                sourceState,
                theme,
                status: 'blocked',
                durationMs: Date.now() - startedAt,
                url,
                violations: [message],
              });
            }
          }
        }
      }
    });
  }

  // ── Pass 2: focused WCAG AA CONTRAST gate (UC2). For the curated primitives /
  // chart / per-domain-accent surfaces, run axe restricted to color-contrast and
  // fail on ANY violation regardless of impact — an AA contrast miss is never
  // "minor" for this gate. Theme is driven via the seeded `data-theme`; the
  // per-domain light-mode accents come from App.jsx applying `data-domain` on
  // the /cfa, /excel, /quant routes under the light palette (see a11y-helpers).
  for (const entry of contrastMatrix) {
    for (const theme of entry.themes) {
      await withThemeContext(theme, async (page) => {
        const startedAt = Date.now();
        const url = new URL(entry.path, address).toString();
        const scope = `contrast:${entry.id} [${theme}]`;
        try {
          await page.setViewportSize(viewports.desktop);
          await page.goto(url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1800);
          // color-contrast IS the WCAG 1.4.3 AA rule; withRules sets runOnly to
          // exactly this rule (it overrides withTags), so the pass measures only
          // AA text/background contrast.
            const result = await new AxeBuilder({ page })
              .withRules(['color-contrast'])
              .analyze();
            const violations = result.violations;
            const violationDetails = formatViolationNodes(violations);
            contrastResults.push({
              id: entry.id,
              label: entry.label,
            path: entry.path,
            theme,
              status: violations.length ? 'blocked' : 'ok',
              durationMs: Date.now() - startedAt,
              url,
              violations: violationDetails,
            });
            if (violations.length) {
              failures.push({
                route: scope,
                violations: violationDetails,
              });
            }
          console.log(`OK a11y contrast ${scope} (${entry.label})`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ route: scope, violations: [message] });
          contrastResults.push({
            id: entry.id,
            label: entry.label,
            path: entry.path,
            theme,
            status: 'blocked',
            durationMs: Date.now() - startedAt,
            url,
            violations: [message],
          });
        }
      });
    }
  }

  // ── Pass 3: A11Y-4 OS preference media probes. Axe does not prove that
  // forced-colors mode has visible focus, removes shadow-only affordances, or
  // that prefers-contrast triggers a real token hardening, so assert those
  // computed styles directly on a curated host/LSAT surface set.
  for (const entry of preferenceMediaMatrix) {
    for (const theme of entry.themes) {
      for (const scenario of ['contrast-more', 'forced-colors']) {
        await withThemeContext(theme, async (page) => {
          const startedAt = Date.now();
          const url = new URL(entry.path, address).toString();
          const scope = `preference:${entry.id}:${scenario} [${theme}]`;
          try {
            await page.setViewportSize(viewports.desktop);
            await page.emulateMedia({
              contrast: 'more',
              forcedColors: scenario === 'forced-colors' ? 'active' : 'none',
            });
            await page.goto(url, { waitUntil: 'networkidle' });
            await waitForBodyText(page, entry.expectedText, scope);
            await page.waitForTimeout(900);
            const result = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
              .analyze();
            const violations = result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
            const violationDetails = formatViolationNodes(violations);
            const snapshot = await collectPreferenceSnapshot(page, entry);
            assertPreferenceSnapshot(snapshot, scope, scenario);
            preferenceResults.push({
              id: entry.id,
              label: entry.label,
              path: entry.path,
              theme,
              scenario,
              status: violations.length ? 'blocked' : 'ok',
              durationMs: Date.now() - startedAt,
              url,
              snapshot,
              violations: violationDetails,
            });
            if (violations.length) {
              failures.push({
                route: scope,
                violations: violationDetails,
              });
            }
            console.log(`OK a11y preference ${scope} (${entry.label})`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ route: scope, violations: [message] });
            preferenceResults.push({
              id: entry.id,
              label: entry.label,
              path: entry.path,
              theme,
              scenario,
              status: 'blocked',
              durationMs: Date.now() - startedAt,
              url,
              violations: [message],
            });
          }
        });
      }
    }
  }
} finally {
  await mkdir('dist/reports', { recursive: true });
  const routeFailures = summarizeRouteFailures(routeResults);
  await writeFile(
    'dist/reports/a11y-check.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), themes: a11yThemes, routeResults, routeFailures, contrastResults, preferenceResults }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  throw new Error(`${failures.length} accessibility / contrast check(s) failed (WCAG AA, light + dark).`);
}
