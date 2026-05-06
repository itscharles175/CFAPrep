import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const ASSET_DIR = 'dist/assets';
const thresholds = [
  { label: 'main app', pattern: /^index-.*\.js$/, maxBytes: 350_000, maxGzipBytes: 110_000, required: true },
  { label: 'CFA summary chunk', pattern: /^cfaSummary-.*\.js$/, maxBytes: 30_000, maxGzipBytes: 10_000, required: false },
  { label: 'Level I async loader', pattern: /^cfaLevel1Runtime-.*\.js$/, maxBytes: 20_000, maxGzipBytes: 8_000, required: true },
  { label: 'Level II async loader', pattern: /^cfaLevel2Runtime-.*\.js$/, maxBytes: 20_000, maxGzipBytes: 8_000, required: true },
  { label: 'CFA content core', pattern: /^cfa-content-core-.*\.js$/, maxBytes: 180_000, maxGzipBytes: 60_000, required: true },
  { label: 'Level I dedicated content chunk', pattern: /^cfa-level1-content-.*\.js$/, maxBytes: 400_000, maxGzipBytes: 120_000, required: false },
  { label: 'Level II dedicated content chunk', pattern: /^cfa-level2-content-.*\.js$/, maxBytes: 400_000, maxGzipBytes: 120_000, required: false },
  { label: 'Level III scaffold chunk', pattern: /^cfa-level3-scaffold-.*\.js$/, maxBytes: 300_000, maxGzipBytes: 120_000, required: true },
  { label: 'Quant route chunk', pattern: /^QuantModule-.*\.js$/, maxBytes: 250_000, maxGzipBytes: 80_000, required: true },
  { label: 'KaTeX', pattern: /^katex-.*\.js$/, maxBytes: 300_000, maxGzipBytes: 95_000, required: true },
  { label: 'Quant/Recharts payload', pattern: /^(recharts-vendor|Analytics)-.*\.js$/, maxBytes: 430_000, maxGzipBytes: 130_000, required: false },
];

async function getAssets() {
  const names = await readdir(ASSET_DIR);
  return Promise.all(
    names
      .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
      .map(async (name) => {
        const filePath = path.join(ASSET_DIR, name);
        const file = await stat(filePath);
        const bytes = file.size;
        const source = await import('node:fs/promises').then((fs) => fs.readFile(filePath));
        return { name, bytes, gzipBytes: gzipSync(source).length };
      }),
  );
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

await mkdir('dist/reports', { recursive: true });
await writeFile('dist/reports/bundle-report.json', `${JSON.stringify(report, null, 2)}\n`);

report.checks.forEach((check) => {
  const asset = check.asset ? `${check.asset.name} ${check.asset.bytes} bytes (${check.asset.gzipBytes} gzip)` : 'no asset';
  console.log(`${check.status.padEnd(14)} ${check.label}: ${asset}`);
});

const failures = report.checks.filter((check) => check.status === 'missing' || check.status === 'over-threshold');
if (failures.length) {
  console.error(`Bundle report failed ${failures.length} threshold check(s).`);
  process.exitCode = 1;
}
