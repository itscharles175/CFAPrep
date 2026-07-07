/**
 * Pure policy helpers for visual-regression baseline enforcement.
 *
 * The screenshot runner owns browser capture and pixel comparison; this module
 * owns the preflight answer to "is this baseline set enforceable?" so the policy
 * can be unit-tested without launching Chromium.
 */

export function visualBaselineName({ id, theme, viewport }) {
  return `${id}-${theme}-${viewport}.png`;
}

export function expectedVisualBaselineNames({ routes, themes, viewports }) {
  return [...routes]
    .flatMap((route) =>
      [...themes].flatMap((theme) =>
        [...viewports].map((viewport) => visualBaselineName({ id: route.id, theme, viewport })),
      ),
    )
    .sort();
}

export function evaluateVisualBaselinePolicy({
  expectedNames,
  existingNames,
  updateBaselines = false,
}) {
  const expected = [...new Set(expectedNames || [])].sort();
  const existing = new Set(existingNames || []);
  const missing = expected.filter((name) => !existing.has(name));
  const extras = [...existing].filter((name) => !expected.includes(name)).sort();

  if (updateBaselines) {
    return {
      status: 'update',
      ok: true,
      expectedCount: expected.length,
      existingCount: existing.size,
      missing,
      extras,
      reason: 'UPDATE_VISUAL_BASELINES is set; missing baselines may be written deliberately.',
    };
  }

  if (expected.length === 0) {
    return {
      status: 'blocked',
      ok: false,
      expectedCount: 0,
      existingCount: existing.size,
      missing,
      extras,
      reason: 'visual regression has no expected baseline names',
    };
  }

  if (missing.length > 0) {
    return {
      status: 'blocked',
      ok: false,
      expectedCount: expected.length,
      existingCount: existing.size,
      missing,
      extras,
      reason:
        `${missing.length} required visual baseline${missing.length === 1 ? ' is' : 's are'} missing; ` +
        'run with UPDATE_VISUAL_BASELINES=1 after reviewing the new frames.',
    };
  }

  return {
    status: 'ok',
    ok: true,
    expectedCount: expected.length,
    existingCount: existing.size,
    missing,
    extras,
    reason: 'all required visual baselines are present',
  };
}
