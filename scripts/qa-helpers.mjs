import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const browserCandidates = [
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

export const viewports = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};

// QA-1 / K4-0 — opt-in inclusion of the /lsat/* routes in the QA gates.
//
// The vendored LSAT domain is served by the same production build, so the gates
// CAN crawl /lsat/* — but the host's existing `visual` / `a11y` CI jobs commit
// only host baselines, so LSAT coverage is gated behind this flag to keep those
// jobs unchanged. The dedicated `lsat-qa-gates` CI job sets INCLUDE_LSAT_ROUTES=1
// (and LSAT_ROUTES_ONLY=1) so the LSAT surface is exercised + baselined there.
export const includeLsatRoutes = process.env.INCLUDE_LSAT_ROUTES === '1';
// When set, run ONLY the LSAT routes (the dedicated job's mode) so its baselines
// + reports stay scoped to /lsat/* and don't duplicate the host gate's work.
export const lsatRoutesOnly = process.env.LSAT_ROUTES_ONLY === '1';

/**
 * Merge a host route set with the LSAT route set per the env flags above. Both
 * lists share the same shape (the consumer only reads fields common to both),
 * so the result is a single array the gate iterates uniformly.
 *
 *   - default (no flags): host routes only — host CI jobs are unchanged.
 *   - INCLUDE_LSAT_ROUTES=1: host ∪ LSAT.
 *   - INCLUDE_LSAT_ROUTES=1 + LSAT_ROUTES_ONLY=1: LSAT only.
 */
export function selectGateRoutes(hostRoutes, lsatRoutes) {
  if (!includeLsatRoutes) return hostRoutes;
  if (lsatRoutesOnly) return lsatRoutes;
  return [...hostRoutes, ...lsatRoutes];
}

export const sourceStateNames = ['empty-source', 'synthetic-source'];

const artifactRoots = ['dist', 'qa-screenshots', 'playwright-report', 'test-results'];
const deniedArtifactExtensions = new Set(['.qvsource', '.pdf', '.epub']);
const deniedArtifactPathPattern = /(^|\/)(source-vault|private-source|cfa-source-bundles?)(\/|$)|(_archive_metadata|official curriculum|curriculum volume|schweser|wiley)/i;
const deniedArtifactTextPattern = /"normalizedText"\s*:|"text"\s*:\s*"[^"]{240,}"|"kind"\s*:\s*"cfa-source-vault"|"privateUseOnly"\s*:\s*true/i;
const allowedPolicyReportPaths = new Set(['dist/reports/cfa-source-policy.json', 'dist/reports/artifact-denylist.json', 'dist/reports/stack-audit.json']);

export async function firstExistingPath(paths = browserCandidates) {
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

async function walk(root) {
  if (!existsSync(root)) return [];
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) out.push(fullPath);
    }
  }
  await visit(root);
  return out;
}

export async function trackedFiles() {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: process.cwd(), windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export async function scanArtifactDenylist({ roots = artifactRoots, includeTracked = false } = {}) {
  const rootFiles = (await Promise.all(roots.map((root) => walk(root)))).flat();
  const files = [...new Set([...(includeTracked ? await trackedFiles() : []), ...rootFiles])]
    .filter((file) => !file.replaceAll('\\', '/').includes('/node_modules/'))
    .sort();
  const violations = [];

  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const extension = extname(file).toLowerCase();
    const inArtifactRoot = roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
    if (deniedArtifactExtensions.has(extension)) {
      violations.push({ file: normalized, reason: `${extension} source artifact is not allowed in tracked files or release artifacts.` });
      continue;
    }
    if (inArtifactRoot && deniedArtifactPathPattern.test(normalized)) {
      violations.push({ file: normalized, reason: 'Artifact path matches private/source-material denylist.' });
      continue;
    }
    if (inArtifactRoot && /\.(json|txt|html|htm|xml|md)$/i.test(file) && !allowedPolicyReportPaths.has(normalized)) {
      const info = await stat(file);
      if (info.size <= 3_000_000) {
        const text = await readFile(file, 'utf8').catch(() => '');
        if (deniedArtifactTextPattern.test(text)) {
          violations.push({ file: normalized, reason: 'Artifact content appears to contain private source-vault text or bundle payload.' });
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    roots,
    scannedFiles: files.length,
    violations,
    status: violations.length ? 'blocked' : 'ok',
  };
}

export async function writeArtifactDenylistReport(report, path = 'dist/reports/artifact-denylist.json') {
  await mkdir('dist/reports', { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function routeSourceStates(route) {
  if (route.id === 'vault') return sourceStateNames;
  if (['cfa-module', 'cfa-quiz', 'cfa-vignette', 'cfa-constructed-response'].includes(route.id)) return ['empty-source'];
  return ['default'];
}

export function routePathForSourceState(route, sourceState) {
  if (route.id === 'vault' && sourceState === 'synthetic-source') return '/vault?sourceQuery=duration';
  return route.path;
}

export async function applySourceState(page, address, sourceState) {
  if (sourceState === 'default') return;
  await page.goto(new URL('/vault', address).toString(), { waitUntil: 'networkidle' });
  await page.evaluate(async (state) => {
    const openRequest = globalThis.indexedDB.open('quantvault');
    const db = await new Promise((resolve, reject) => {
      openRequest.onerror = () => reject(openRequest.error);
      openRequest.onsuccess = () => resolve(openRequest.result);
    });
    const stores = ['sourceDocuments', 'sourceChunks', 'sourceIndexes', 'sourceIngestionRuns', 'sourceLinks', 'sourceLinkOverrides'];
    await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      stores.forEach((store) => tx.objectStore(store).clear());
    });
    if (state !== 'synthetic-source') {
      db.close();
      return;
    }
    const importedAt = new Date().toISOString();
    const document = {
      id: 'source:synthetic-duration',
      title: 'Synthetic Duration Guide',
      level: 'level1',
      year: 2026,
      publisher: 'QuantVault QA',
      sourceKind: 'user-source',
      format: 'text',
      sha256: 'synthetic-duration-hash',
      sizeBytes: 512,
      canonical: true,
      privateUseOnly: true,
      topicIds: ['fixed-income'],
      coverageTags: ['level1', 'fixed-income', 'qa'],
      chunkCount: 1,
      importedAt,
    };
    const chunk = {
      id: 'source:synthetic-duration:chunk:0001',
      documentId: document.id,
      chunkIndex: 0,
      locator: 'chunk 1',
      text: 'Synthetic private source fixture covering duration, convexity, immunization, and yield curve risk for visual and accessibility QA.',
      normalizedText: 'synthetic private source fixture covering duration convexity immunization and yield curve risk for visual and accessibility qa',
      topicIds: ['fixed-income'],
      sourceHash: document.sha256,
      importedAt,
    };
    const indexRows = ['duration', 'convexity', 'immunization', 'yield'].map((token) => ({
      id: `token:${token}`,
      token,
      documentIds: [document.id],
      chunkIds: [chunk.id],
      updatedAt: importedAt,
    }));
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sourceDocuments', 'sourceChunks', 'sourceIndexes', 'sourceIngestionRuns'], 'readwrite');
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      tx.objectStore('sourceDocuments').put(document);
      tx.objectStore('sourceChunks').put(chunk);
      indexRows.forEach((row) => tx.objectStore('sourceIndexes').put(row));
      tx.objectStore('sourceIngestionRuns').put({
        id: 'source-run:synthetic-qa',
        rootPath: '<synthetic-qa>',
        startedAt: importedAt,
        completedAt: importedAt,
        status: 'completed',
        documentCount: 1,
        chunkCount: 1,
        bytesScanned: 512,
        warnings: [],
        errors: [],
        policy: { privateUseOnly: true, allowStandardExport: false, textStorage: 'indexeddb' },
      });
    });
    db.close();
  }, sourceState);
}

export function summarizeRouteFailures(routeResults, limit = 8) {
  return routeResults
    .filter((row) => row.status && row.status !== 'ok')
    .slice(0, limit)
    .map((row) => ({
      routeId: [row.routeId, row.viewport, row.sourceState].filter(Boolean).join(':'),
      path: row.path,
      expectedText: row.expectedText,
      message: row.message || (row.violations || []).join('; ') || 'Route check failed.',
      durationMs: row.durationMs,
      url: row.url,
    }));
}
