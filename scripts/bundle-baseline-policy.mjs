export const BUNDLE_BASELINE_SCHEMA = 'studyvault.bundle-baseline.v1';

export const DEFAULT_BUNDLE_GROWTH_POLICY = {
  maxGzipGrowthRatio: 0.05,
  maxGzipGrowthBytes: 10_240,
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function stableAssetKey(name) {
  const input = String(name || '');
  const match = input.match(/^(.*)(\.[^.]+)$/);
  if (!match) return input;
  const [, body, ext] = match;
  const lastHyphen = body.lastIndexOf('-');
  if (lastHyphen < 0) return input;

  const finalSegment = body.slice(lastHyphen + 1);
  if (/^[A-Za-z0-9_]{8,}$/.test(finalSegment)) {
    return `${body.slice(0, lastHyphen)}-[hash]${ext}`;
  }

  // Rolldown/Vite JS chunk hashes can include "-" and "_", so a generated chunk
  // may end in e.g. "-CKQ-AJ2A.js" or "-Dokp1U_-.js". Limit this two-segment
  // fallback to JS-like assets so descriptive font names such as
  // KaTeX_Size4-Regular-DWFBv043.ttf still normalize only their final hash.
  if (!/^\.(js|mjs|css|wasm)$/.test(ext)) return input;
  const prefix = body.slice(0, lastHyphen);
  const previousHyphen = prefix.lastIndexOf('-');
  if (previousHyphen < 0) return input;
  const candidate = body.slice(previousHyphen + 1);
  const hasDigitOrUnderscore = /[0-9_]/.test(candidate);
  const hasInteriorHyphen = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(candidate);
  if (
    candidate.length >= 8 &&
    candidate.length <= 12 &&
    /^[A-Za-z0-9_-]+$/.test(candidate) &&
    (hasDigitOrUnderscore || hasInteriorHyphen)
  ) {
    return `${body.slice(0, previousHyphen)}-[hash]${ext}`;
  }
  return input;
}

function baselineEntryForAsset(asset, assetKey = stableAssetKey(asset?.name)) {
  if (!asset) return null;
  return {
    assetKey,
    stableAssetKey: stableAssetKey(asset.name),
    assetName: asset.name,
    bytes: asset.bytes,
    gzipBytes: asset.gzipBytes,
  };
}

function assetsFromChecks(checks = []) {
  return checks.map((check) => check.asset).filter(Boolean);
}

function baselineEntriesForAssets(assets = []) {
  const groups = new Map();
  for (const asset of assets) {
    const key = stableAssetKey(asset.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(asset);
  }

  const entries = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...group].sort((a, b) => b.gzipBytes - a.gzipBytes || b.bytes - a.bytes || a.name.localeCompare(b.name));
    sorted.forEach((asset, index) => {
      entries.push(baselineEntryForAsset(asset, sorted.length > 1 ? `${key}#${index + 1}` : key));
    });
  }
  return entries;
}

function assetMapFromEntries(entries, failures, scope) {
  const map = {};
  for (const entry of entries) {
    if (!entry?.assetKey) continue;
    if (map[entry.assetKey]) {
      failures.push({
        assetKey: entry.assetKey,
        status: 'duplicate-asset-key',
        message: `${scope} contains duplicate normalized bundle asset key ${entry.assetKey}`,
      });
      continue;
    }
    map[entry.assetKey] = entry;
  }
  return map;
}

export function buildBundleBaseline({
  assets,
  checks,
  generatedAt = new Date().toISOString(),
  growthPolicy = DEFAULT_BUNDLE_GROWTH_POLICY,
} = {}) {
  const sourceAssets = assets || assetsFromChecks(checks);
  const failures = [];
  const baselineAssets = assetMapFromEntries(baselineEntriesForAssets(sourceAssets), failures, 'bundle baseline');
  if (failures.length) {
    throw new Error(failures.map((failure) => failure.message).join('; '));
  }
  return {
    schemaVersion: BUNDLE_BASELINE_SCHEMA,
    generatedAt,
    growthPolicy,
    assets: baselineAssets,
  };
}

export function evaluateBundleBaseline({
  baseline,
  assets,
  checks,
  growthPolicy = baseline?.growthPolicy ?? DEFAULT_BUNDLE_GROWTH_POLICY,
} = {}) {
  const failures = [];
  const deltas = [];
  const baselineAssets = baseline?.assets ?? {};
  const currentEntries = baselineEntriesForAssets(assets || assetsFromChecks(checks));
  const currentAssets = assetMapFromEntries(currentEntries, failures, 'current bundle');

  if (!baseline || baseline.schemaVersion !== BUNDLE_BASELINE_SCHEMA) {
    failures.push({
      label: 'baseline',
      status: 'blocked',
      message: `bundle baseline must use schema ${BUNDLE_BASELINE_SCHEMA}`,
    });
  }

  const assetKeys = [...new Set([...Object.keys(baselineAssets), ...Object.keys(currentAssets)])].sort();
  for (const assetKey of assetKeys) {
    const current = currentAssets[assetKey] ?? null;
    const previous = baselineAssets[assetKey] ?? null;

    if (!current && previous) {
      deltas.push({ assetKey, status: 'removed', current: null, baseline: previous });
      continue;
    }

    if (current && !previous) {
      const oversized = current.gzipBytes > growthPolicy.maxGzipGrowthBytes;
      const delta = {
        status: oversized ? 'new-over-budget' : 'new',
        assetKey: current.assetKey,
        current,
        baseline: null,
        gzipDeltaBytes: current.gzipBytes,
        gzipDeltaRatio: null,
        maxGzipGrowthRatio: growthPolicy.maxGzipGrowthRatio,
        maxGzipGrowthBytes: growthPolicy.maxGzipGrowthBytes,
      };
      deltas.push(delta);
      if (oversized) {
        failures.push({
          assetKey,
          status: 'new-over-budget',
          message: `${assetKey} is new and exceeds the ${growthPolicy.maxGzipGrowthBytes} byte gzip new-asset budget`,
          gzipDeltaBytes: current.gzipBytes,
          maxGzipGrowthBytes: growthPolicy.maxGzipGrowthBytes,
        });
      }
      continue;
    }

    const gzipDeltaBytes = current.gzipBytes - previous.gzipBytes;
    const bytesDelta = current.bytes - previous.bytes;
    const gzipDeltaRatio =
      isFiniteNumber(previous.gzipBytes) && previous.gzipBytes > 0
        ? gzipDeltaBytes / previous.gzipBytes
        : gzipDeltaBytes > 0
          ? Number.POSITIVE_INFINITY
          : 0;
    const gzipGrowthFailed =
      gzipDeltaBytes > 0 &&
      (gzipDeltaRatio > growthPolicy.maxGzipGrowthRatio ||
        gzipDeltaBytes > growthPolicy.maxGzipGrowthBytes);
    const status = gzipGrowthFailed ? 'over-baseline' : 'ok';
    const delta = {
      status,
      assetKey: current.assetKey,
      current,
      baseline: previous,
      bytesDelta,
      gzipDeltaBytes,
      gzipDeltaRatio,
      maxGzipGrowthRatio: growthPolicy.maxGzipGrowthRatio,
      maxGzipGrowthBytes: growthPolicy.maxGzipGrowthBytes,
    };
    deltas.push(delta);
    if (gzipGrowthFailed) {
      failures.push({
        assetKey,
        status,
        message:
          `${assetKey} gzip grew by ${gzipDeltaBytes} bytes ` +
          `(${(gzipDeltaRatio * 100).toFixed(2)}%) over the committed baseline`,
        gzipDeltaBytes,
        gzipDeltaRatio,
        maxGzipGrowthRatio: growthPolicy.maxGzipGrowthRatio,
        maxGzipGrowthBytes: growthPolicy.maxGzipGrowthBytes,
      });
    }
  }

  return {
    status: failures.length ? 'blocked' : 'ok',
    ok: failures.length === 0,
    growthPolicy,
    deltas,
    failures,
  };
}

export function formatBundleDeltaMarkdown({ deltas, failures, generatedAt = new Date().toISOString() } = {}) {
  const rows = [
    '| Asset | Status | Current gzip | Baseline gzip | Delta gzip | Current bytes | Baseline bytes |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const delta of deltas || []) {
    const current = delta.current;
    const baseline = delta.baseline;
    const gzipDelta = isFiniteNumber(delta.gzipDeltaBytes)
      ? `${delta.gzipDeltaBytes >= 0 ? '+' : ''}${delta.gzipDeltaBytes}`
      : 'n/a';
    rows.push(
      [
        delta.assetKey,
        delta.status,
        current ? current.gzipBytes : 'n/a',
        baseline ? baseline.gzipBytes : 'n/a',
        gzipDelta,
        current ? current.bytes : 'n/a',
        baseline ? baseline.bytes : 'n/a',
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    );
  }

  const failureLines = (failures || []).length
    ? ['', '## Failures', '', ...(failures || []).map((failure) => `- ${failure.message}`)]
    : [];

  return [
    '# Bundle Baseline Delta',
    '',
    `Generated: ${generatedAt}`,
    '',
    ...rows,
    ...failureLines,
    '',
  ].join('\n');
}
