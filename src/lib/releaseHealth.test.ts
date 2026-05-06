import { describe, expect, it } from 'vitest';
import { buildReleaseGateReport } from './releaseHealth';

describe('release health report', () => {
  it('opens active Level I, Level II, and Level III editorial gates once every pack is exam-ready', () => {
    const report = buildReleaseGateReport({
      generatedAt: '2026-05-04T00:00:00.000Z',
      bundle: {
        checks: [
          {
            label: 'index',
            status: 'ok',
            asset: { name: 'index-test.js', bytes: 10, gzipBytes: 5 },
          },
        ],
      },
    });

    expect(report.generatedAt).toBe('2026-05-04T00:00:00.000Z');
    expect(report.status).toBe('pending');
    expect(report.summary.level1ValidatedTopics).toBe(0);
    expect(report.summary.level1ExamReadyTopics).toBe(10);
    expect(report.summary.level2ExamReadyTopics).toBe(10);
    expect(report.summary.level2TopicCount).toBe(10);
    expect(report.summary.level3ExamReadyTopics).toBe(6);
    expect(report.summary.level3TopicCount).toBe(6);
    expect(report.summary.activeCurriculumWarnings).toBe(0);
    expect(report.summary.futureDiagnostics).toBe(0);
    expect(report.gates.find((gate) => gate.id === 'level1-editorial')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'level2-editorial')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'level3-editorial')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'bundle-report')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'visual-regression')?.status).toBe('pending');
    expect(report.gates.find((gate) => gate.id === 'accessibility')?.status).toBe('pending');
    expect(report.gates.find((gate) => gate.id === 'release-checklist')?.artifactPaths).toContain('dist/reports/release-manifest.json');
    expect(report.activeLevels).toEqual(['level1', 'level2', 'level3']);
    expect(report.blockers.some((blocker) => blocker.includes('template-derived rows'))).toBe(false);
  });

  it('marks bundle reports as blocked when a tracked threshold fails', () => {
    const report = buildReleaseGateReport({
      bundle: {
        checks: [
          {
            label: 'index',
            status: 'over-threshold',
            asset: { name: 'index-large.js', bytes: 500_000, gzipBytes: 160_000 },
          },
        ],
      },
    });

    expect(report.summary.bundleFailures).toBe(1);
    expect(report.gates.find((gate) => gate.id === 'bundle-report')?.status).toBe('blocked');
    expect(report.blockers.some((blocker) => blocker.includes('route bundle thresholds'))).toBe(true);
  });

  it('uses executable gate results when they are available', () => {
    const report = buildReleaseGateReport({
      gateResults: {
        verify: {
          id: 'verify',
          command: 'npm run verify',
          status: 'ok',
          exitCode: 0,
          durationMs: 12_000,
          completedAt: '2026-05-04T00:00:00.000Z',
        },
        smoke: {
          id: 'smoke',
          command: 'npm run smoke',
          status: 'blocked',
          exitCode: 1,
          durationMs: 900,
          completedAt: '2026-05-04T00:00:01.000Z',
        },
        'visual-regression': {
          id: 'visual-regression',
          command: 'npm run visual:regression',
          status: 'ok',
          exitCode: 0,
          durationMs: 1_900,
          completedAt: '2026-05-04T00:00:02.000Z',
          artifactPaths: [],
        },
        accessibility: {
          id: 'accessibility',
          command: 'npm run a11y:check',
          status: 'ok',
          exitCode: 0,
          durationMs: 2_900,
          completedAt: '2026-05-04T00:00:03.000Z',
          artifactPaths: [],
        },
        'release-checklist': {
          id: 'release-checklist',
          command: 'npm run release:checklist',
          status: 'ok',
          exitCode: 0,
          durationMs: 300,
          completedAt: '2026-05-04T00:00:04.000Z',
          artifactPaths: ['dist/reports/release-manifest.json'],
        },
      },
    });

    expect(report.gates.find((gate) => gate.id === 'verify')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'smoke')?.status).toBe('blocked');
    expect(report.gates.find((gate) => gate.id === 'visual-regression')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'accessibility')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'release-checklist')?.completedAt).toBe('2026-05-04T00:00:04.000Z');
  });
});
