import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  DEFAULT_BUNDLE_GROWTH_POLICY,
  buildBundleBaseline,
  evaluateBundleBaseline,
  formatBundleDeltaMarkdown,
} from './bundle-baseline-policy.mjs';

const ASSET_DIR = 'dist/assets';
const BASELINE_PATH = 'tests/bundle-baseline.json';
const REPORT_PATH = 'dist/reports/bundle-report.json';
const DELTA_MARKDOWN_PATH = 'dist/reports/bundle-report.md';
const WRITE_BASELINE =
  process.argv.includes('--write-baseline') ||
  process.argv.includes('--update-baseline') ||
  process.env.UPDATE_BUNDLE_BASELINE === '1';
const SKIP_BASELINE = process.argv.includes('--skip-baseline');

const thresholds = [
  { label: 'main app', pattern: /^index-.*\.js$/, maxBytes: 250_000, maxGzipBytes: 75_000, required: true },
  { label: 'CFA summary chunk', pattern: /^cfaSummary-.*\.js$/, maxBytes: 30_000, maxGzipBytes: 10_000, required: false },
  { label: 'Level I async loader', pattern: /^cfaLevel1Runtime-.*\.js$/, maxBytes: 50_000, maxGzipBytes: 15_000, required: true },
  { label: 'Level II async loader', pattern: /^cfaLevel2Runtime-.*\.js$/, maxBytes: 20_000, maxGzipBytes: 8_000, required: true },
  { label: 'CFA content core', pattern: /^cfa-content-core-.*\.js$/, maxBytes: 180_000, maxGzipBytes: 60_000, required: false },
  { label: 'Level I dedicated content chunk', pattern: /^cfa-level1-content-.*\.js$/, maxBytes: 400_000, maxGzipBytes: 120_000, required: false },
  { label: 'Level II dedicated content chunk', pattern: /^cfa-level2-content-.*\.js$/, maxBytes: 400_000, maxGzipBytes: 120_000, required: true },
  { label: 'Level III dedicated content chunk', pattern: /^cfa-level3-content-.*\.js$/, maxBytes: 400_000, maxGzipBytes: 120_000, required: true },
  { label: 'Legacy CFA runtime scaffold', pattern: /^cfa-legacy-runtime-.*\.js$/, maxBytes: 280_000, maxGzipBytes: 95_000, required: false },
  { label: 'Quant route chunk', pattern: /^QuantModule-.*\.js$/, maxBytes: 250_000, maxGzipBytes: 80_000, required: true },
  { label: 'KaTeX', pattern: /^katex-.*\.js$/, maxBytes: 300_000, maxGzipBytes: 95_000, required: true },
  { label: 'Quant/Recharts payload', pattern: /^(recharts-vendor|Analytics)-.*\.js$/, maxBytes: 430_000, maxGzipBytes: 130_000, required: false },
  // audit M21 — the largest single shipped asset (~21.6MB) is a .wasm that the
  // gate never scanned (it filtered to .js/.css only), so an ML-asset size
  // regression slipped through. Budget it explicitly. gzip cap is generous since
  // wasm compresses poorly and the offline footprint is what matters.
  { label: 'ONNX runtime wasm', pattern: /^ort-wasm.*\.wasm$/, maxBytes: 24_000_000, maxGzipBytes: 9_000_000, required: false },
];

async function getAssets() {
  const names = await readdir(ASSET_DIR);
  return Promise.all(
    names
      .filter((name) => /\.(js|mjs|css|wasm|woff2?|ttf)$/.test(name))
      .map(async (name) => {
        const filePath = path.join(ASSET_DIR, name);
        const file = await stat(filePath);
        const bytes = file.size;
        const source = await readFile(filePath);
        return { name, bytes, gzipBytes: gzipSync(source).length };
      }),
  );
}

function baselineCandidateAssets(assets, checks) {
  const checkedNames = new Set(checks.map((check) => check.asset?.name).filter(Boolean));
  return assets
    .filter((asset) => checkedNames.has(asset.name) || asset.gzipBytes >= DEFAULT_BUNDLE_GROWTH_POLICY.maxGzipGrowthBytes)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readBaseline() {
  const raw = await readFile(BASELINE_PATH, 'utf8');
  return JSON.parse(raw);
}

const assets = await getAssets();
const checks = thresholds.map((threshold) => {
  const matches = assets.filter((asset) => threshold.pattern.test(asset.name));
  const largest = matches.sort((a, b) => b.bytes - a.bytes)[0] || null;
  const missing = !largest;
  const overBytes = largest ? largest.bytes > threshold.maxBytes : false;
  const overGzip = largest ? largest.gzipBytes > threshold.maxGzipBytes : false;
  return {
    ...threshold,
    asset: largest,
    status: missing && threshold.required ? 'missing' : overBytes || overGzip ? 'over-threshold' : missing ? 'not-found' : 'ok',
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  totalAssets: assets.length,
  checks,
  largestAssets: [...assets].sort((a, b) => b.bytes - a.bytes).slice(0, 12),
};
const bundleBaselineAssets = baselineCandidateAssets(assets, checks);

await mkdir('dist/reports', { recursive: true });

if (WRITE_BASELINE) {
  report.bundleBaseline = {
    status: 'updated',
    path: BASELINE_PATH,
  };
  await mkdir(path.dirname(BASELINE_PATH), { recursive: true });
  await writeFile(
    BASELINE_PATH,
    `${JSON.stringify(buildBundleBaseline({ assets: bundleBaselineAssets, generatedAt: report.generatedAt }), null, 2)}\n`,
  );
} else if (!SKIP_BASELINE) {
  const baseline = await readBaseline();
  const baselineResult = evaluateBundleBaseline({ baseline, assets: bundleBaselineAssets });
  report.bundleBaseline = {
    path: BASELINE_PATH,
    ...baselineResult,
  };
  await writeFile(
    DELTA_MARKDOWN_PATH,
    formatBundleDeltaMarkdown({
      deltas: baselineResult.deltas,
      failures: baselineResult.failures,
      generatedAt: report.generatedAt,
    }),
  );
} else {
  report.bundleBaseline = {
    status: 'skipped',
    ok: true,
    path: BASELINE_PATH,
    failures: [],
    deltas: [],
  };
}

await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

report.checks.forEach((check) => {
  const asset = check.asset ? `${check.asset.name} ${check.asset.bytes} bytes (${check.asset.gzipBytes} gzip)` : 'no asset';
  console.log(`${check.status.padEnd(14)} ${check.label}: ${asset}`);
});
if (report.bundleBaseline?.status === 'updated') {
  console.log(`updated        bundle baseline: ${BASELINE_PATH}`);
} else if (report.bundleBaseline?.status === 'ok') {
  console.log(`ok             bundle baseline: ${BASELINE_PATH}`);
} else if (report.bundleBaseline?.status === 'blocked') {
  console.error(`blocked        bundle baseline: ${report.bundleBaseline.failures.length} regression(s)`);
}

const failures = report.checks.filter((check) => check.status === 'missing' || check.status === 'over-threshold');
const baselineFailures = report.bundleBaseline?.failures || [];
if (failures.length || baselineFailures.length) {
  if (failures.length) console.error(`Bundle report failed ${failures.length} threshold check(s).`);
  if (baselineFailures.length) console.error(`Bundle baseline failed ${baselineFailures.length} trend check(s).`);
  process.exitCode = 1;
}
