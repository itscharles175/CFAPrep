import { describe, expect, it } from 'vitest';
import {
  BUNDLE_BASELINE_SCHEMA,
  buildBundleBaseline,
  evaluateBundleBaseline,
  formatBundleDeltaMarkdown,
  stableAssetKey,
} from './bundle-baseline-policy.mjs';

function check({ label = 'main app', name = 'index-abc12345.js', bytes = 100_000, gzipBytes = 20_000, required = true } = {}) {
  return {
    label,
    required,
    status: 'ok',
    asset: { name, bytes, gzipBytes },
  };
}

describe('bundle baseline policy', () => {
  it('normalizes hashed Vite asset names into stable keys', () => {
    expect(stableAssetKey('index-BYKLtAha.js')).toBe('index-[hash].js');
    expect(stableAssetKey('pdf.worker.min-iDqQPrd3.mjs')).toBe('pdf.worker.min-[hash].mjs');
    expect(stableAssetKey('ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm')).toBe(
      'ort-wasm-simd-threaded.jsep-[hash].wasm',
    );
    expect(stableAssetKey('KaTeX_Size4-Regular-DWFBv043.ttf')).toBe(
      'KaTeX_Size4-Regular-[hash].ttf',
    );
    expect(stableAssetKey('ContentOps-CKQ-AJ2A.js')).toBe('ContentOps-[hash].js');
    expect(stableAssetKey('surrealDriver-Dokp1U_-.js')).toBe('surrealDriver-[hash].js');
    expect(stableAssetKey('ai-markdown-pVvpNdp-.js')).toBe('ai-markdown-pVvpNdp-.js');
  });

  it('builds a committed baseline from present bundle checks only', () => {
    const baseline = buildBundleBaseline({
      checks: [check(), { label: 'optional missing', required: false, status: 'not-found', asset: null }],
      generatedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(baseline.schemaVersion).toBe(BUNDLE_BASELINE_SCHEMA);
    expect(Object.keys(baseline.assets)).toEqual(['index-[hash].js']);
    expect(baseline.assets['index-[hash].js'].assetName).toBe('index-abc12345.js');
  });

  it('fails when gzip grows more than five percent', () => {
    const baseline = buildBundleBaseline({ checks: [check({ gzipBytes: 20_000 })] });
    const result = evaluateBundleBaseline({
      baseline,
      checks: [check({ gzipBytes: 21_100 })],
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ assetKey: 'index-[hash].js', status: 'over-baseline' })]),
    );
  });

  it('fails when gzip grows more than ten kilobytes even below five percent', () => {
    const baseline = buildBundleBaseline({ checks: [check({ gzipBytes: 500_000 })] });
    const result = evaluateBundleBaseline({
      baseline,
      checks: [check({ gzipBytes: 511_000 })],
    });

    expect(result.ok).toBe(false);
    expect(result.failures[0].gzipDeltaBytes).toBe(11_000);
  });

  it('allows exact growth-budget boundaries', () => {
    const fivePercentBaseline = buildBundleBaseline({ checks: [check({ gzipBytes: 20_000 })] });
    const fivePercent = evaluateBundleBaseline({
      baseline: fivePercentBaseline,
      checks: [check({ gzipBytes: 21_000 })],
    });
    const byteBudgetBaseline = buildBundleBaseline({ checks: [check({ gzipBytes: 500_000 })] });
    const byteBudget = evaluateBundleBaseline({
      baseline: byteBudgetBaseline,
      checks: [check({ gzipBytes: 510_240 })],
    });

    expect(fivePercent.ok).toBe(true);
    expect(byteBudget.ok).toBe(true);
  });

  it('allows removed assets, reports small new assets, and blocks large new assets', () => {
    const baseline = buildBundleBaseline({
      checks: [check({ label: 'optional chunk', required: false, name: 'legacy-abcdef12.js' })],
    });
    const removed = evaluateBundleBaseline({
      baseline,
      checks: [{ label: 'optional chunk', required: false, status: 'not-found', asset: null }],
    });
    const added = evaluateBundleBaseline({
      baseline,
      checks: [
        { label: 'optional chunk', required: false, status: 'not-found', asset: null },
        check({ label: 'new optional', required: false, name: 'new-abcdef12.js', gzipBytes: 1024 }),
      ],
    });
    const addedLarge = evaluateBundleBaseline({
      baseline,
      checks: [
        { label: 'optional chunk', required: false, status: 'not-found', asset: null },
        check({ label: 'new optional', required: false, name: 'new-abcdef12.js', gzipBytes: 10_241 }),
      ],
    });

    expect(removed.ok).toBe(true);
    expect(removed.deltas[0].status).toBe('removed');
    expect(added.ok).toBe(true);
    expect(added.deltas.some((delta) => delta.status === 'new')).toBe(true);
    expect(addedLarge.ok).toBe(false);
    expect(addedLarge.failures[0].status).toBe('new-over-budget');
  });

  it('fails closed on an invalid committed baseline schema', () => {
    const result = evaluateBundleBaseline({
      baseline: { schemaVersion: 'wrong', assets: {} },
      checks: [check()],
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'baseline', status: 'blocked' })]),
    );
  });

  it('keeps duplicate normalized chunks as deterministic logical assets', () => {
    const baseline = buildBundleBaseline({
      assets: [
        { name: 'Analytics-ClCKrlgJ.js', bytes: 12_000, gzipBytes: 3_000 },
        { name: 'Analytics-hrLPvdk7.js', bytes: 63_000, gzipBytes: 17_000 },
      ],
      generatedAt: '2026-07-06T00:00:00.000Z',
    });

    expect(Object.keys(baseline.assets)).toEqual(['Analytics-[hash].js#1', 'Analytics-[hash].js#2']);
    expect(baseline.assets['Analytics-[hash].js#1'].assetName).toBe('Analytics-hrLPvdk7.js');
    expect(baseline.assets['Analytics-[hash].js#2'].assetName).toBe('Analytics-ClCKrlgJ.js');
  });

  it('formats a markdown delta table for CI artifacts', () => {
    const baseline = buildBundleBaseline({ checks: [check()] });
    const result = evaluateBundleBaseline({ baseline, checks: [check({ gzipBytes: 20_500 })] });
    const markdown = formatBundleDeltaMarkdown({ deltas: result.deltas, failures: result.failures, generatedAt: 'now' });

    expect(markdown).toContain('# Bundle Baseline Delta');
    expect(markdown).toContain('| index-[hash].js | ok | 20500 | 20000 | +500 |');
  });
});
