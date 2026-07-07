import { access, mkdir, writeFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { resolveBrowserExecutable, seedThemeInitScript } from './a11y-helpers.mjs';

const REPORT_PATH = 'dist/reports/lsat-semantic-a11y.json';
const RULES = [
  'button-name',
  'aria-progressbar-name',
  'listitem',
  'aria-prohibited-attr',
  'nested-interactive',
];
const ROUTES = [
  { id: 'home', path: '/lsat' },
  { id: 'preptests', path: '/lsat/preptests' },
  { id: 'rc-lab', path: '/lsat/rc-lab' },
  { id: 'srs', path: '/lsat/srs' },
  { id: 'analytics', path: '/lsat/analytics' },
  { id: 'bank', path: '/lsat/bank' },
];
const VIEWPORTS = [
  { id: 'desktop', width: 1280, height: 900, isMobile: false },
  { id: 'mobile', width: 390, height: 844, isMobile: true },
];

await access('dist/index.html').catch(() => {
  throw new Error('Production dist is missing. Run npm run build before lsat:a11y:semantic.');
});
await mkdir('dist/reports', { recursive: true });

const server = await preview({
  preview: {
    host: '127.0.0.1',
    port: 4181,
    strictPort: false,
    open: false,
  },
});

const executablePath = await resolveBrowserExecutable();
if (!executablePath) {
  await new Promise((resolve) => server.httpServer.close(resolve));
  throw new Error(
    'No Chromium-compatible browser found for LSAT semantic a11y probe. Install Chrome/Edge, ' +
      'set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run "npx playwright install chromium".',
  );
}

const address = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:4181/';
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
const failures = [];

try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });
    await seedThemeInitScript(context, 'dark');
    const page = await context.newPage();

    try {
      for (const route of ROUTES) {
        const startedAt = Date.now();
        const url = new URL(route.path, address).toString();
        const result = {
          routeId: route.id,
          path: route.path,
          viewport: viewport.id,
          url,
          status: 'ok',
          durationMs: 0,
          violations: [],
        };

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(750);
          const axe = await new AxeBuilder({ page }).withRules(RULES).analyze();
          result.violations = axe.violations.map((violation) => ({
            id: violation.id,
            help: violation.help,
            impact: violation.impact,
            nodes: violation.nodes.map((node) => ({
              target: node.target,
              html: node.html,
              failureSummary: node.failureSummary,
            })),
          }));
          if (result.violations.length) {
            result.status = 'blocked';
            failures.push({
              routeId: route.id,
              viewport: viewport.id,
              violations: result.violations.map((violation) => ({
                id: violation.id,
                count: violation.nodes.length,
              })),
            });
          }
          console.log(`${result.status === 'ok' ? 'OK' : 'FAIL'} lsat semantic ${route.id} ${viewport.id}`);
        } catch (error) {
          result.status = 'blocked';
          result.error = error instanceof Error ? error.message : String(error);
          failures.push({ routeId: route.id, viewport: viewport.id, error: result.error });
          console.error(`FAIL lsat semantic ${route.id} ${viewport.id}: ${result.error}`);
        } finally {
          result.durationMs = Date.now() - startedAt;
          results.push(result);
        }
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), rules: RULES, results, failures }, null, 2)}\n`,
  );
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

if (failures.length) {
  throw new Error(`${failures.length} LSAT semantic a11y probe(s) failed. See ${REPORT_PATH}.`);
}
