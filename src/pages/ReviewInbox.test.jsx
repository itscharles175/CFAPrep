import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/learning', () => ({
  forecastReviewLoad: vi.fn(),
  getReadinessByTopic: vi.fn(),
  getReviewInbox: vi.fn(),
  getStudyPlan: vi.fn(),
  saveStudyPlanSettings: vi.fn(),
}));
vi.mock('../lib/aiTutorContracts', () => ({
  getTutorProvider: vi.fn(),
  isTutorEnabledFromEnv: () => false,
}));
vi.mock('../domains/cfa/useLevel3Pathway', () => ({ useLevel3Pathway: () => ['portfolio-management'] }));
vi.mock('../lib/lsatReviewBridge', () => ({
  fetchUnifiedDue: vi.fn(),
  LSAT_REVIEW_PATH: '/lsat/srs',
}));
vi.mock('../lib/scrollRestore', () => ({ useScrollRestoration: vi.fn() }));
vi.mock('../lib/studyTrail', () => ({
  recordStudyContext: vi.fn(),
  getResumeTarget: vi.fn(),
  clearResumeHandle: vi.fn(),
}));
vi.mock('../lib/psychometrics/abilitySnapshots', () => ({ readLatestAbilitySnapshot: vi.fn() }));
vi.mock('../components/SourceContext', () => ({ SourceRail: () => <div>Source context</div> }));
vi.mock('../lib/studyContext', () => ({
  useStudyContext: () => [{ domain: 'cfa', cfaLevel: 'level2', goal: 'retention' }],
  workspaceHref: () => '/cfa/level2/mock',
}));

import { forecastReviewLoad, getReadinessByTopic, getReviewInbox, getStudyPlan } from '../lib/learning';
import { fetchUnifiedDue } from '../lib/lsatReviewBridge';
import { getResumeTarget, recordStudyContext } from '../lib/studyTrail';
import { readLatestAbilitySnapshot } from '../lib/psychometrics/abilitySnapshots';
import ReviewInbox from './ReviewInbox';

function arrange({ items = [], forecast = [], nextActions = [] } = {}) {
  getReviewInbox.mockResolvedValue(items);
  getReadinessByTopic.mockResolvedValue([]);
  getStudyPlan.mockResolvedValue({
    dueToday: 0,
    forecastReviewCount: 0,
    targetLevel: 'level2',
    dailyTargetMinutes: 45,
    examDate: null,
    mockCadenceDays: 14,
    restDays: [],
    daysToExam: null,
    nextActions,
  });
  forecastReviewLoad.mockResolvedValue(forecast);
  fetchUnifiedDue.mockResolvedValue({ ok: false, dueCount: 0, items: [] });
  getResumeTarget.mockResolvedValue(null);
  recordStudyContext.mockResolvedValue(undefined);
  readLatestAbilitySnapshot.mockResolvedValue(null);
}

function renderPage() {
  return render(<MemoryRouter initialEntries={['/review']}><ReviewInbox /></MemoryRouter>);
}

describe('ReviewInbox focus hierarchy', () => {
  it('leads with one compact empty queue state and a context-aware practice action', async () => {
    arrange();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Your queue is clear' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start practice' })).toHaveAttribute('href', '/cfa/level2/mock');
    expect(screen.getByLabelText('Review status')).toHaveTextContent('All caught up');
    expect(screen.queryByText('Repair Vault')).not.toBeInTheDocument();
    expect(screen.queryByText('Review Forecast')).not.toBeInTheDocument();
  });

  it('keeps plan controls behind a disclosure', async () => {
    arrange({
      items: [{
        id: 'fixed-income-duration',
        type: 'weak-objective',
        title: 'Revisit duration',
        subtitle: 'Fixed income',
        path: '/cfa/level2/fixed-income',
      }],
      nextActions: [{ label: 'Review', title: 'Revisit duration', path: '/cfa/level2/fixed-income', reason: 'Low retention' }],
    });
    renderPage();

    const planDisclosure = await screen.findByText('Plan and follow-up');
    expect(planDisclosure.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(planDisclosure);

    const settingsDisclosure = screen.getByText('Plan settings');
    expect(settingsDisclosure.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(settingsDisclosure);
    expect(screen.getByText('Target level')).toBeInTheDocument();
    expect(screen.getByText('Daily minutes')).toBeInTheDocument();
    expect(screen.getByText('Exam date')).toBeInTheDocument();
    expect(screen.getByText('Mock cadence')).toBeInTheDocument();
  });
});
