import { describe, expect, it } from 'vitest';
import { buildReleaseGateReport } from './releaseHealth';

describe('release health report', () => {
  it('blocks public release while Level I packs are validated but not editorial exam-ready', () => {
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
    expect(report.status).toBe('blocked');
    expect(report.summary.level1ValidatedTopics).toBe(10);
    expect(report.summary.level1ExamReadyTopics).toBe(0);
    expect(report.gates.find((gate) => gate.id === 'level1-editorial')?.status).toBe('blocked');
    expect(report.gates.find((gate) => gate.id === 'bundle-report')?.status).toBe('ok');
    expect(report.blockers.some((blocker) => blocker.includes('template-derived rows'))).toBe(true);
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
      },
    });

    expect(report.gates.find((gate) => gate.id === 'verify')?.status).toBe('ok');
    expect(report.gates.find((gate) => gate.id === 'smoke')?.status).toBe('blocked');
  });
});
