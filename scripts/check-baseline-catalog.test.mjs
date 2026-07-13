import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_CATALOG_SCHEMA,
  checkBaselineCatalog,
  renderBaselineCatalogMarkdown,
  validateBaselineCatalog,
} from './check-baseline-catalog.mjs';

function fixtureCatalog(overrides = {}) {
  return {
    schemaVersion: BASELINE_CATALOG_SCHEMA,
    baselines: [
      {
        id: 'example-baseline',
        title: 'Example Baseline',
        kind: 'fixture',
        owner: 'QA',
        storage: 'committed',
        paths: [{ path: 'tests/example.json', type: 'file' }],
        verify: { command: 'npm run check:example' },
        refresh: { command: 'node scripts/example.mjs --write' },
        ci: { command: 'npm run check:example' },
        docs: ['docs/TESTING-BASELINES.md'],
        failureMode: 'Example baseline must not drift.',
        ...overrides,
      },
    ],
  };
}

function withTempRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-catalog-'));
  try {
    mkdirSync(join(root, 'tests'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'check:example': 'node scripts/example.mjs' } }));
    writeFileSync(join(root, 'tests', 'example.json'), '{}\n');
    writeFileSync(join(root, 'scripts', 'example.mjs'), 'console.log("ok");\n');
    writeFileSync(join(root, 'docs', 'TESTING-BASELINES.md'), '# Baselines\n');
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('baseline catalog check', () => {
  it('validates the real baseline catalog and generated docs contract', () => {
    const result = checkBaselineCatalog();

    expect(result.ok).toBe(true);
    expect(result.baselineCount).toBeGreaterThanOrEqual(8);
  });

  it('fails on missing committed paths and unknown npm scripts', () => withTempRepo((root) => {
    const catalog = fixtureCatalog({
      paths: [{ path: 'tests/missing.json', type: 'file' }],
      verify: { command: 'npm run missing-script' },
    });
    const result = validateBaselineCatalog(catalog, { repoRoot: root });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tests/missing.json is missing'),
        expect.stringContaining('missing-script'),
      ]),
    );
  }));

  it('allows optional external baseline paths while warning about them', () => withTempRepo((root) => {
    const catalog = fixtureCatalog({
      storage: 'approved-ci-cache',
      paths: [{ path: 'tests/visual-baselines', type: 'directory', required: false, minFiles: 20 }],
    });
    const result = validateBaselineCatalog(catalog, { repoRoot: root });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('tests/visual-baselines is missing')]);
  }));

  it('renders deterministic markdown from the catalog', () => {
    const markdown = renderBaselineCatalogMarkdown(fixtureCatalog());

    expect(markdown).toContain('# Testing Baselines and Golden Fixtures');
    expect(markdown).toContain('| example-baseline | committed | tests/example.json | npm run check:example |');
    expect(markdown).toContain('## Example Baseline');
  });
});
