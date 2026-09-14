import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  emptyCollection: { toArray: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../lib/learning', () => ({
  getAnalyticsSummary: vi.fn(),
}));
vi.mock('../lib/progressStore', () => ({
  db: {
    masterySnapshots: mocks.emptyCollection,
    reviewItems: mocks.emptyCollection,
    questionResults: mocks.emptyCollection,
  },
  forecastReviewLoad: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/scheduler', () => ({ predictRetention: vi.fn() }));
vi.mock('../components/SourceContext', () => ({ SourceRail: () => <div>Source context</div> }));
vi.mock('../domains/cfa/useLevel3Pathway', () => ({ useLevel3Pathway: () => ['portfolio-management'] }));
vi.mock('../lib/examReadiness', () => ({ projectExamReadiness: vi.fn(() => ({ points: [] })) }));
vi.mock('../lib/psychometrics/forecastAttribution', () => ({ attributeForecast: vi.fn(() => ({ drivers: [] })) }));
vi.mock('../lib/psychometrics/recommendations', () => ({ recommendFromAttribution: vi.fn(() => []) }));
vi.mock('../lib/storage', () => ({ getStorage: () => ({ settings: { get: vi.fn().mockResolvedValue(null) } }) }));
vi.mock('../lib/lsatAnalyticsBridge', () => ({
  getLsatActivity: vi.fn().mockResolvedValue({ reachable: false, days: [] }),
  getLsatCalibration: vi.fn().mockResolvedValue({ reachable: false, bands: [] }),
}));
vi.mock('../lib/lsatCrossDomainBridge', () => ({
  getLsatCrossDomain: vi.fn().mockResolvedValue({
    reachable: false,
    accuracyByDomain: [],
    weakestTypes: [],
    trend: [],
    studyMinutes: 0,
    combinedStreakDays: 0,
  }),
}));
vi.mock('../lib/studyContext', () => ({
  useStudyContext: () => [{ domain: 'quant', goal: 'skill-building' }],
  workspaceHref: () => '/quant',
}));

import { getAnalyticsSummary } from '../lib/learning';
import { getLsatActivity } from '../lib/lsatAnalyticsBridge';
import { getLsatCrossDomain } from '../lib/lsatCrossDomainBridge';
import Analytics from './Analytics';

const EMPTY_SUMMARY = {
  totals: { questionsAnswered: 0, sessions: 0, studyTimeSeconds: 0, mockAttempts: 0, vignetteAttempts: 0, artifacts: 0 },
  byTopic: [],
  byLevel: [],
  byItemType: [],
  confidenceCalibration: [],
  byDifficulty: [],
  byErrorCategory: [],
  essayRubrics: [],
  skillLabs: [],
  constructedResponseWeaknesses: [],
  objectiveImpacts: [],
  rollingTrend: [],
};

describe('Analytics scope and empty evidence', () => {
  it('states the global contract for Quant and withholds modeled analytics until evidence exists', async () => {
    getAnalyticsSummary.mockResolvedValue(EMPTY_SUMMARY);
    render(<MemoryRouter initialEntries={['/analytics']}><Analytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'No study evidence yet' })).toBeInTheDocument();
    expect(screen.getByLabelText('Analytics scope')).toHaveTextContent('Global rollup');
    expect(screen.getByLabelText('Analytics scope')).toHaveTextContent('Host Study includes CFA, Quant, and Excel. Current context: Quant.');
    expect(screen.getByRole('link', { name: 'Start Quant practice' })).toHaveAttribute('href', '/quant');
    expect(screen.queryByText('Exam-Readiness Cockpit')).not.toBeInTheDocument();
    expect(screen.queryByText('Why This Forecast — Drivers & Next Steps')).not.toBeInTheDocument();
  });

  it('labels local data as Host Study instead of CFA-only', async () => {
    getAnalyticsSummary.mockResolvedValue(EMPTY_SUMMARY);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/analytics']}><Analytics /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'No study evidence yet' });
    await user.click(screen.getByRole('radio', { name: 'Host Study' }));

    expect(screen.getByLabelText('Analytics scope')).toHaveTextContent('Host Study');
    expect(screen.getByRole('radio', { name: 'Host Study' })).toHaveAttribute('aria-checked', 'true');
  });

  it('does not fabricate a host forecast when only LSAT evidence is available', async () => {
    getAnalyticsSummary.mockResolvedValue(EMPTY_SUMMARY);
    getLsatActivity.mockResolvedValue({ reachable: true, days: [{ date: '2026-09-14', questions: 2 }] });
    getLsatCrossDomain.mockResolvedValue({
      reachable: true,
      accuracyByDomain: [{ domain: 'lsat', attempts: 2, accuracy: 0.5, streakDays: 1 }],
      weakestTypes: [],
      trend: [],
      studyMinutes: 3,
      combinedStreakDays: 1,
    });
    render(<MemoryRouter initialEntries={['/analytics']}><Analytics /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'LSAT evidence is available' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open LSAT Analytics' })).toHaveAttribute('href', '/lsat/analytics');
    expect(screen.queryByText('Exam-Readiness Cockpit')).not.toBeInTheDocument();
    expect(screen.queryByText('Why This Forecast — Drivers & Next Steps')).not.toBeInTheDocument();
  });
});
