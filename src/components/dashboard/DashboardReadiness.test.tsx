import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  aggregateBlindReviewOutcomes,
  aggregateReadiness,
  curveFromEstimate,
  curveTrend,
  daysToExam,
  masterySeriesFromEstimate,
  scoreReadiness,
  type DomainLearningCurve,
} from '../../lib/dashboardMetrics';
import { DEFAULT_SHARED_STUDY_PROFILE, type SharedStudyProfile } from '../../lib/types/StudyProfile';
import type { UnifiedAbilityEstimate } from '../../lib/learningTypes';
import { DashboardSparklineGrid } from './DashboardSparklineGrid';
import { DashboardReadinessChecklist } from './DashboardReadinessChecklist';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function estimate(overrides: Partial<UnifiedAbilityEstimate> = {}): UnifiedAbilityEstimate {
  return {
    domain: 'cfa',
    q_type: null,
    section_type: null,
    ability: 0.4,
    mastery: 0.7,
    uncertainty: 0.2,
    evidence_n: 24,
    accuracy: 0.68,
    avg_time_ms: 42000,
    model: 'local_irt_elo_v2',
    learning_velocity: {
      slope_per_week: 0.05,
      window: 'local_attempt_history',
      early_signal: 0.5,
      recent_signal: 0.65,
      days: 21,
    },
    plateau: false,
    mastery_eta_days: 30,
    components: {
      blind_review_outcomes: { timed_ok: 10, timing_problem: 3, concept_gap: 2, lucky: 1 },
      days: 21,
      model: 'local_irt_elo_v2',
      uses_official_score_anchor_only: false,
    },
    ...overrides,
  };
}

function curve(overrides: Partial<DomainLearningCurve> = {}): DomainLearningCurve {
  return {
    domain: 'cfa',
    label: 'CFA',
    reachable: true,
    mastery: 0.7,
    uncertainty: 0.2,
    slopePerWeek: 0.05,
    plateau: false,
    masteryEtaDays: 30,
    evidenceN: 24,
    accuracy: 0.68,
    blindReviewOutcomes: { timed_ok: 10, timing_problem: 3, concept_gap: 2, lucky: 1 },
    series: [0.55, 0.62, 0.7],
    trend: 'up',
    ...overrides,
  };
}

function profile(overrides: Partial<SharedStudyProfile> = {}): SharedStudyProfile {
  return { ...DEFAULT_SHARED_STUDY_PROFILE, ...overrides };
}

// ---------------------------------------------------------------------------
// Pure shaping
// ---------------------------------------------------------------------------

describe('curveTrend', () => {
  it('labels by slope once there is evidence', () => {
    expect(curveTrend(0.05, 10)).toBe('up');
    expect(curveTrend(-0.05, 10)).toBe('down');
    expect(curveTrend(0.0, 10)).toBe('flat');
  });
  it('returns new with no evidence', () => {
    expect(curveTrend(0.5, 0)).toBe('new');
  });
});

describe('masterySeriesFromEstimate', () => {
  it('builds an ascending series ending at current mastery for a rising signal', () => {
    const series = masterySeriesFromEstimate(estimate());
    expect(series).toHaveLength(3);
    expect(series[series.length - 1]).toBeCloseTo(0.7, 4);
    expect(series[0]).toBeLessThan(series[series.length - 1]);
    series.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  it('falls back to a flat segment when there is evidence but no velocity window', () => {
    const series = masterySeriesFromEstimate(
      estimate({
        evidence_n: 3,
        learning_velocity: { slope_per_week: 0, window: 'insufficient_data', early_signal: null, recent_signal: null },
      }),
    );
    expect(series).toEqual([0.7, 0.7]);
  });

  it('returns an empty series with no evidence at all', () => {
    const series = masterySeriesFromEstimate(
      estimate({
        evidence_n: 0,
        learning_velocity: { slope_per_week: 0, window: 'insufficient_data', early_signal: null, recent_signal: null },
      }),
    );
    expect(series).toEqual([]);
  });
});

describe('curveFromEstimate', () => {
  it('shapes a raw ability body into a reachable curve', () => {
    const c = curveFromEstimate('quant', estimate({ mastery: 0.55, plateau: true }));
    expect(c.reachable).toBe(true);
    expect(c.domain).toBe('quant');
    expect(c.label).toBe('Quant');
    expect(c.mastery).toBeCloseTo(0.55, 4);
    expect(c.plateau).toBe(true);
    expect(c.blindReviewOutcomes.timing_problem).toBe(3);
  });

  it('degrades a garbled body to an unreachable curve', () => {
    expect(curveFromEstimate('excel', null).reachable).toBe(false);
    expect(curveFromEstimate('excel', [1, 2, 3]).reachable).toBe(false);
    expect(curveFromEstimate('excel', 'nope').series).toEqual([]);
  });
});

describe('aggregateBlindReviewOutcomes', () => {
  it('sums the 2x2 counts across reachable domains', () => {
    const total = aggregateBlindReviewOutcomes([
      curve(),
      curve({ blindReviewOutcomes: { timed_ok: 1, timing_problem: 1, concept_gap: 5, lucky: 0 } }),
    ]);
    expect(total).toEqual({ timed_ok: 11, timing_problem: 4, concept_gap: 7, lucky: 1 });
  });
});

describe('daysToExam', () => {
  it('counts forward days from a fixed now', () => {
    const now = new Date('2026-06-16T12:00:00Z');
    expect(daysToExam('2026-06-26', now)).toBe(10);
    expect(daysToExam('2026-06-16', now)).toBe(0);
  });
  it('returns null for an unset or garbled date', () => {
    expect(daysToExam(null)).toBeNull();
    expect(daysToExam('not-a-date')).toBeNull();
  });
});

describe('scoreReadiness', () => {
  const now = new Date('2026-06-16T12:00:00Z');

  it('greens the goal/mastery/evidence checks for a strong profile', () => {
    const checks = scoreReadiness(
      { curves: [curve({ mastery: 0.85, evidenceN: 40 })], profile: profile({ hasPlan: true, examDate: '2026-09-01' }) },
      {
        blindReview: { timed_ok: 30, timing_problem: 1, concept_gap: 1, lucky: 0 },
        calibrationGap: 0.05,
        srsDue: 0,
        now,
      },
    );
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId.goal).toBe('green');
    expect(byId.mastery).toBe('green');
    expect(byId.evidence).toBe('green');
    expect(byId['br-control']).toBe('green');
    expect(byId.calibration).toBe('green');
    expect(byId.srs).toBe('green');
  });

  it('reds the goal check when no plan or exam date exists', () => {
    const checks = scoreReadiness(
      { curves: [curve()], profile: profile({ hasPlan: false, examDate: null }) },
      { now },
    );
    expect(checks.find((c) => c.id === 'goal')?.status).toBe('red');
  });

  it('marks dimensions unknown when the signal is absent', () => {
    const checks = scoreReadiness(
      { curves: [curve({ reachable: false, evidenceN: 0, series: [] })], profile: profile() },
      { now },
    );
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId.mastery).toBe('unknown');
    expect(byId['br-control']).toBe('unknown');
    expect(byId.calibration).toBe('unknown');
    expect(byId.srs).toBe('unknown');
  });

  it('flags a below-target plateau red', () => {
    const checks = scoreReadiness(
      { curves: [curve({ plateau: true, mastery: 0.5, trend: 'flat', evidenceN: 20 })], profile: profile() },
      { now },
    );
    expect(checks.find((c) => c.id === 'plateau')?.status).toBe('red');
  });

  it('always returns all nine dimensions', () => {
    const checks = scoreReadiness({ curves: [curve()], profile: profile() }, { now });
    expect(checks.map((c) => c.id).sort()).toEqual(
      ['br-control', 'calibration', 'evidence', 'forecast', 'goal', 'mastery', 'pacing', 'plateau', 'srs'].sort(),
    );
  });
});

describe('aggregateReadiness', () => {
  it('rolls up to the worst scored status, ignoring unknown', () => {
    expect(
      aggregateReadiness([
        { id: 'goal', label: 'g', status: 'green', detail: '' },
        { id: 'mastery', label: 'm', status: 'unknown', detail: '' },
        { id: 'srs', label: 's', status: 'amber', detail: '' },
      ]),
    ).toBe('amber');
    expect(
      aggregateReadiness([{ id: 'goal', label: 'g', status: 'unknown', detail: '' }]),
    ).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

describe('DashboardSparklineGrid', () => {
  it('renders one labelled sparkline per domain', () => {
    render(
      <DashboardSparklineGrid
        curves={[curve(), curve({ domain: 'quant', label: 'Quant' }), curve({ domain: 'excel', label: 'Excel' })]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Per-domain learning curves' })).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(3);
    // a11y label summarizes mastery + trend
    expect(screen.getByLabelText(/CFA mastery 70%, improving/)).toBeInTheDocument();
  });

  it('renders a no-signal cell for an unreachable domain', () => {
    render(<DashboardSparklineGrid curves={[curve({ reachable: false, evidenceN: 0, series: [] })]} />);
    expect(screen.getByLabelText(/CFA has no learning curve yet/)).toBeInTheDocument();
    expect(screen.getByText('no signal yet')).toBeInTheDocument();
  });

  it('renders nothing for an empty curve set', () => {
    const { container } = render(<DashboardSparklineGrid curves={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DashboardReadinessChecklist', () => {
  const checks = scoreReadiness(
    { curves: [curve({ mastery: 0.85, evidenceN: 40 })], profile: profile({ hasPlan: true, examDate: '2026-09-01' }) },
    { blindReview: { timed_ok: 30, timing_problem: 1, concept_gap: 1, lucky: 0 }, calibrationGap: 0.05, srsDue: 0, now: new Date('2026-06-16T12:00:00Z') },
  );

  it('renders every check row with its label + verdict (status not color-only)', () => {
    render(<DashboardReadinessChecklist checks={checks} />);
    expect(screen.getByRole('region', { name: 'Exam-readiness checklist' })).toBeInTheDocument();
    expect(screen.getByText('Mastery')).toBeInTheDocument();
    expect(screen.getByText('Blind-review control')).toBeInTheDocument();
    // textual status words appear so meaning is not color-only
    expect(screen.getAllByText('On track').length).toBeGreaterThan(0);
  });

  it('renders nothing for an empty check set', () => {
    const { container } = render(<DashboardReadinessChecklist checks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
