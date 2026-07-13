/*
 * UC2 — shared helpers for the WCAG contrast / accessibility gate.
 *
 * Kept separate from scripts/qa-helpers.mjs (which other QA scripts own) so the
 * a11y gate can grow its own browser-resolution + theme + contrast-matrix logic
 * without touching the shared module. Imported only by scripts/a11y-check.mjs.
 *
 * The two product-level mechanisms this gate must exercise (verified against the
 * app source):
 *
 *   - THEME is the `data-theme` attribute on <html>, applied at bootstrap from
 *     `localStorage['qv-theme']` (src/lib/theme.ts → src/main.jsx, before the
 *     first React render). Seeding that key before the page's own scripts run
 *     reproduces a real light / dark session with no flash. 'system' is the
 *     absence of the attribute and resolves to dark in headless Chromium, so we
 *     pin 'light' / 'dark' explicitly to cover BOTH palettes deterministically.
 *
 *   - PER-DOMAIN ACCENT is the `data-domain` attribute App.jsx sets on <body>
 *     for /cfa, /excel, /quant. tokens.css tightens those accents under
 *     `:root[data-theme="light"] [data-domain="…"]` for AA on white — exactly
 *     the light-mode accents this gate must protect. Visiting those routes in
 *     the 'light' theme drives that override automatically (App.jsx sets the
 *     attribute from the URL), so no extra DOM poking is needed.
 */

import { access } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserCandidates, firstExistingPath, includeLsatRoutes, lsatRoutesOnly } from './qa-helpers.mjs';

/* global window */

/**
 * Themes the gate runs every check under. The host renders two palettes
 * (data-theme="light" | "dark"); both must pass WCAG AA contrast.
 */
export const a11yThemes = ['dark', 'light'];

/**
 * Resolve a Chromium-compatible executable for the gate.
 *
 * Order of preference:
 *   1. The host's existing candidate list (system Chrome / Edge, or the
 *      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH override) — keeps local runs working
 *      on a developer's installed browser exactly as before.
 *   2. The Playwright-managed Chromium that `npx playwright install chromium`
 *      drops into the ms-playwright cache — this is what CI uses. playwright-core
 *      knows its own download path via chromium.executablePath(); we only fall
 *      back to it when nothing on the system list exists.
 *
 * Returns null when neither is available so the caller can fail loudly.
 */
export async function resolveBrowserExecutable() {
  const systemPath = await firstExistingPath(browserCandidates);
  if (systemPath) return systemPath;

  // playwright-core throws if no browsers descriptor is found; guard it so a
  // missing install degrades to "null" rather than an opaque crash.
  let managedPath = null;
  try {
    managedPath = chromium.executablePath();
  } catch {
    // No Playwright-managed Chromium descriptor — leave managedPath null.
  }
  if (managedPath) {
    try {
      await access(managedPath);
      return managedPath;
    } catch {
      // Descriptor pointed at a path that was never downloaded.
    }
  }
  return null;
}

/**
 * Seed `localStorage['qv-theme']` BEFORE any page script runs, so the app's
 * synchronous bootstrap (src/main.jsx) applies the matching `data-theme` on the
 * very first paint. Uses addInitScript, which re-runs on every navigation in the
 * context — so a single call covers all goto()s for that theme.
 *
 * 'system' is represented by removing the key (the app then defers to the OS via
 * `prefers-color-scheme`); we always pass 'light' / 'dark' here for determinism.
 */
export async function seedThemeInitScript(context, theme) {
  await context.addInitScript((value) => {
    try {
      if (value === 'system') {
        window.localStorage.removeItem('qv-theme');
      } else {
        window.localStorage.setItem('qv-theme', value);
      }
    } catch {
      // Storage can throw in locked-down contexts; the gate still proceeds with
      // whatever the default palette resolves to.
    }
  }, theme);
}

/**
 * The focused CONTRAST matrix (UC2 acceptance surface). Each entry is checked in
 * the listed themes with axe restricted to the color-contrast rule, failing on
 * ANY violation regardless of impact (a contrast miss is never "minor" for an
 * AA gate). Routes mirror src/routes/routeManifest.ts.
 *
 *   - 'style'   → the Style Gallery: every UI primitive (buttons, inputs,
 *                 cards, badges, states) + the viz/illustration components, in
 *                 BOTH themes. The single richest primitives + chart surface.
 *   - charts    → analytics + knowledge-graph render chart SVGs; checked in
 *                 BOTH themes so series/label colors stay AA.
 *   - accents   → /cfa, /excel, /quant in LIGHT theme, where tokens.css applies
 *                 the per-domain light-mode accent overrides this gate protects.
 */
const hostContrastMatrix = [
  { id: 'style-primitives', path: '/style', themes: ['dark', 'light'], label: 'UI primitives + Style gallery' },
  { id: 'analytics-charts', path: '/analytics', themes: ['dark', 'light'], label: 'Analytics chart SVGs' },
  { id: 'knowledge-graph-charts', path: '/knowledge-graph', themes: ['dark', 'light'], label: 'Knowledge-graph canvas' },
  { id: 'accent-cfa-light', path: '/cfa', themes: ['light'], label: 'CFA light-mode accent' },
  { id: 'accent-excel-light', path: '/excel', themes: ['light'], label: 'Excel light-mode accent' },
  { id: 'accent-quant-light', path: '/quant', themes: ['light'], label: 'Quant light-mode accent' },
];

/**
 * QA-1 / K4-0 — the focused CONTRAST surfaces for the vendored LSAT domain
 * (served at /lsat/*). Opt-in via INCLUDE_LSAT_ROUTES=1 (the dedicated
 * `lsat-qa-gates` CI job). These mirror the host curation intent: the richest
 * primitive surfaces (analytics charts, the question bank's dense form/table
 * chrome, settings' form-dense panels) in BOTH themes, so an AA contrast miss in
 * the LSAT shell fails the gate too. Routes are app-relative paths under the
 * /lsat basename — the same URLs the host serves.
 */
const lsatContrastMatrix = [
  { id: 'lsat-analytics-charts', path: '/lsat/analytics', themes: ['dark', 'light'], label: 'LSAT analytics chart SVGs' },
  { id: 'lsat-bank-forms', path: '/lsat/bank', themes: ['dark', 'light'], label: 'LSAT question bank forms + tables' },
  { id: 'lsat-settings-forms', path: '/lsat/settings', themes: ['dark', 'light'], label: 'LSAT settings form-dense panels' },
];

// Host-only by default; host ∪ LSAT (or LSAT-only) when the flags are set, so the
// dedicated job's contrast pass is scoped to /lsat/* and never re-checks the host.
export const contrastMatrix = !includeLsatRoutes
  ? hostContrastMatrix
  : lsatRoutesOnly
    ? lsatContrastMatrix
    : [...hostContrastMatrix, ...lsatContrastMatrix];

/**
 * A11Y-4 — focused OS accessibility-preference surfaces.
 *
 * These are intentionally smaller than the full route sweep: they exercise the
 * richest primitive/chrome pages under `prefers-contrast: more` and
 * `forced-colors: active`, then scripts/a11y-check.mjs asserts computed styles
 * that axe cannot infer, especially outline-based focus in forced-colors mode.
 */
const hostPreferenceMediaMatrix = [
  {
    id: 'host-style-preferences',
    path: '/style',
    expectedText: 'Style',
    themes: ['dark', 'light'],
    label: 'Host primitives under OS contrast preferences',
    surfaceSelector: '.surface, .qv-card, .qv-list-row, .panel, .metric-card',
    focusSelector: 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  },
  {
    id: 'host-analytics-preferences',
    path: '/analytics',
    expectedText: 'Analytics',
    themes: ['dark', 'light'],
    label: 'Host chart surface under OS contrast preferences',
    surfaceSelector: '.surface, .qv-card, .panel, .border',
    chartSelector: 'svg path, svg line, svg text',
  },
];

const lsatPreferenceMediaMatrix = [
  {
    id: 'lsat-bank-preferences',
    path: '/lsat/bank',
    expectedText: 'Question bank',
    themes: ['dark', 'light'],
    label: 'LSAT dense bank controls under OS contrast preferences',
    surfaceSelector: '.border, .rounded-card.border, .bg-card.border, .bg-surface-1.border',
    focusSelector: 'button, a[href], input, select, textarea, [role="button"], [role="radio"], [tabindex]:not([tabindex="-1"])',
  },
  {
    id: 'lsat-analytics-preferences',
    path: '/lsat/analytics',
    expectedText: 'Analytics',
    themes: ['dark', 'light'],
    label: 'LSAT chart surface under OS contrast preferences',
    surfaceSelector: '.border, .rounded-card.border, .bg-card.border, .bg-surface-1.border',
    chartSelector: 'svg path, svg line, svg text, [data-heatmap-root] [role="img"]',
  },
];

export const preferenceMediaMatrix = !includeLsatRoutes
  ? hostPreferenceMediaMatrix
  : lsatRoutesOnly
    ? lsatPreferenceMediaMatrix
    : [...hostPreferenceMediaMatrix, ...lsatPreferenceMediaMatrix];
