import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routePathForSourceState, routeSourceStates, scanArtifactDenylist, summarizeRouteFailures } from './qa-helpers.mjs';

describe('QA helper policies', () => {
  it('adds synthetic source-state coverage only to practical route surfaces', () => {
    expect(routeSourceStates({ id: 'vault', path: '/vault' })).toEqual(['empty-source', 'synthetic-source']);
    expect(routePathForSourceState({ id: 'vault', path: '/vault' }, 'synthetic-source')).toBe('/vault?sourceQuery=duration');
    expect(routeSourceStates({ id: 'cfa-module', path: '/cfa/level1/fixed-income' })).toEqual(['empty-source']);
    expect(routeSourceStates({ id: 'dashboard', path: '/' })).toEqual(['default']);
  });

  it('summarizes route failures with viewport and source-state context', () => {
    expect(
      summarizeRouteFailures([
        {
          routeId: 'vault',
          path: '/vault?sourceQuery=duration',
          expectedText: 'Vault',
          viewport: 'mobile',
          sourceState: 'synthetic-source',
          status: 'blocked',
          durationMs: 42,
          message: 'overflow',
        },
      ]),
    ).toEqual([
      {
        routeId: 'vault:mobile:synthetic-source',
        path: '/vault?sourceQuery=duration',
        expectedText: 'Vault',
        message: 'overflow',
        durationMs: 42,
        url: undefined,
      },
    ]);
  });

  it('blocks denied private source artifacts from release roots', async () => {
    const root = join('dist', 'qa-helper-test');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'leak.qvsource'), '{}');
    const report = await scanArtifactDenylist({ roots: [root] });
    await rm(root, { recursive: true, force: true });

    expect(report.status).toBe('blocked');
    expect(report.violations[0].file).toContain('leak.qvsource');
  });
});
