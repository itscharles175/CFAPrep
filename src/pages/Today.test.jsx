import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/studyDirector', () => ({
  buildStudyPlan: vi.fn(),
}));

import { buildStudyPlan } from '../lib/studyDirector';
import Today, {
  createDomainFallbackPlan,
  summarizeTodayWorkload,
  todayHeroTitle,
  todayPrimaryActionLabel,
} from './Today';
import { StudySessionProvider } from '../components/session';

afterEach(() => {
  window.localStorage.removeItem('studyvault:study-context:v1');
  window.localStorage.removeItem('studyvault.focus-session.v1');
});

function renderToday() {
  return render(
    <MemoryRouter>
      <StudySessionProvider>
        <Today />
      </StudySessionProvider>
    </MemoryRouter>,
  );
}

describe('Today focus-mode landing', () => {
  it('renders the loading state before the plan resolves', async () => {
    buildStudyPlan.mockReturnValue(new Promise(() => undefined)); // never resolves
    renderToday();
    expect(await screen.findByText(/Loading today’s plan/i)).toBeInTheDocument();
  });

  it('renders the headline, dueCount/weakCount badges, and the hero top action', async () => {
    buildStudyPlan.mockResolvedValue({
      generatedAt: '2026-05-27T00:00:00Z',
      headline: '2 reviews due, 1 weak topic to shore up',
      dueCount: 2,
      weakCount: 1,
      peakReviewDay: { date: '2026-05-30', count: 9 },
      actions: [
        { kind: 'review', title: 'Modified duration', path: '/review', reason: 'Scheduled by FSRS — 42% retention remaining.', priority: 100 },
        { kind: 'weak-topic', title: 'Equity Investments', path: '/cfa/level1/equity', reason: 'Topic readiness is only 58% — needs reinforcement.', priority: 70 },
        { kind: 'forecast-spike', title: 'Upcoming review spike', path: '/cfa', reason: '9 items due on 2026-05-30 — review ahead to reduce load.', priority: 55 },
      ],
    });
    renderToday();

    // The hero top action renders in the always-visible scrolling content.
    expect(await screen.findByText('Modified duration')).toBeInTheDocument();

    // Supporting rationale and follow-up work stay behind the full-plan
    // disclosure so the recommended activity owns the initial viewport.
    await userEvent.click(screen.getByText('Full plan'));
    expect(screen.getByText('2 reviews due, 1 weak topic to shore up')).toBeInTheDocument();
    // "Equity Investments" appears in the actions list AND the targeted-drill
    // header (since it's the first weak-topic action) — assert >= 1.
    expect(screen.getAllByText(/Topic readiness is only 58%/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Upcoming review spike')).toBeInTheDocument();
    expect(screen.getByText(/Peak 2026-05-30/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Why this plan/i })).toBeInTheDocument();
    expect(screen.queryByText(/🤖 Why this plan/)).not.toBeInTheDocument();

    // Top action card links to the review path
    const reviewLinks = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/review');
    expect(reviewLinks.length).toBeGreaterThan(0);
  });

  it('handles an empty plan without crashing', async () => {
    buildStudyPlan.mockResolvedValue({
      generatedAt: '2026-05-27T00:00:00Z',
      headline: 'No urgent items — great progress!',
      dueCount: 0,
      weakCount: 0,
      peakReviewDay: null,
      actions: [
        { kind: 'continue', title: 'Continue studying', path: '/cfa', reason: 'No urgent reviews or weak areas — keep building momentum.', priority: 30 },
      ],
    });
    renderToday();
    // The hero "continue" action is in the always-visible scrolling content.
    await waitFor(() => expect(screen.getByText('Continue studying')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Open CFA workspace/i })).toBeInTheDocument();
    expect(screen.queryByText('0 reviews due')).not.toBeInTheDocument();
    expect(screen.queryByText('0 weak topics')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Full plan'));
    expect(screen.getByText('No urgent items — great progress!')).toBeInTheDocument();
  });

  it.each([
    ['lsat', 'Practice an LSAT section', '/lsat/practice', 'Start activity'],
    ['quant', 'Continue Quant practice', '/quant', 'Open Quant workspace'],
    ['excel', 'Continue Excel practice', '/excel', 'Open Excel workspace'],
  ])('keeps the Today surface scoped to %s', async (domain, title, path, actionLabel) => {
    window.localStorage.setItem(
      'studyvault:study-context:v1',
      JSON.stringify({ domain, cfaLevel: 'level1', goal: 'balanced' }),
    );

    renderToday();

    expect(await screen.findByText(title)).toBeInTheDocument();
    const primaryLink = screen.getByRole('link', { name: new RegExp(actionLabel) });
    expect(primaryLink).toHaveAttribute('href', path);
    if (domain === 'lsat') {
      expect(screen.getByText(/About 35 min now · Then 15 min review/)).toBeInTheDocument();
      expect(screen.getByText('2 activities · 50 min total')).toBeInTheDocument();
    }
    expect(screen.getAllByText(new RegExp(`${domain === 'lsat' ? 'LSAT' : domain[0].toUpperCase() + domain.slice(1)} ·`)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cross-domain plan unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/What to study next/i)).not.toBeInTheDocument();
  });

  it('attributes a focus session to the selected non-CFA curriculum', async () => {
    window.localStorage.setItem(
      'studyvault:study-context:v1',
      JSON.stringify({ domain: 'lsat', cfaLevel: 'level1', goal: 'exam-readiness' }),
    );
    renderToday();

    const primaryLink = await screen.findByRole('link', { name: /Start activity/i });
    await userEvent.click(primaryLink);

    const persisted = JSON.parse(window.localStorage.getItem('studyvault.focus-session.v1'));
    expect(persisted.domain).toBe('lsat');
    expect(persisted.topic).toBe('lsat:section');
    expect(screen.getByText(/LSAT · Your next exam focused step/i)).toBeInTheDocument();
  });

  it('makes a paused same-domain session the explicit hero action', async () => {
    window.localStorage.setItem(
      'studyvault:study-context:v1',
      JSON.stringify({ domain: 'lsat', cfaLevel: 'level1', goal: 'balanced' }),
    );
    window.localStorage.setItem('studyvault.focus-session.v1', JSON.stringify({
      version: 1,
      sessionId: 'paused-lsat',
      status: 'paused',
      domain: 'lsat',
      topic: 'lsat:section',
      startedAt: '2026-09-14T12:00:00.000Z',
      segmentStartedAtMs: null,
      accumulatedMs: 420000,
      questionsAnswered: 7,
      score: 5,
      updatedAt: '2026-09-14T12:07:00.000Z',
      saveError: null,
    }));
    renderToday();

    expect(await screen.findByText('Resume LSAT section')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Resume activity/i })).toBeInTheDocument();
  });

  it('builds deterministic non-CFA plans with goal-specific rationale', () => {
    const plan = createDomainFallbackPlan('quant', 'skill-building');
    expect(plan.actions[0]).toMatchObject({
      domain: 'quant',
      path: '/quant',
      estimatedMinutes: 30,
    });
    expect(plan.headline).toBe('Quant · Skill building');
    expect(plan.rationale).toMatch(/deterministic local fallback/i);
    expect(plan.actions[0].reason).toMatch(/fluency/i);
  });

  it('explains the ordered shortlist as now, remainder, and total', () => {
    const plan = createDomainFallbackPlan('lsat', 'balanced');
    expect(summarizeTodayWorkload(plan)).toMatchObject({
      currentLabel: 'About 35 min now',
      remainderLabel: 'Then 15 min review',
      totalLabel: '2 activities · 50 min total',
      activityCount: 2,
      totalMinutes: 50,
    });
  });

  it('names broad workspace destinations honestly and reflects a resumable session', () => {
    expect(todayPrimaryActionLabel({ domain: 'cfa', path: '/cfa', sessionStatus: 'none' })).toBe('Open CFA workspace');
    expect(todayPrimaryActionLabel({ domain: 'quant', path: '/quant', sessionStatus: 'none' })).toBe('Open Quant workspace');
    expect(todayPrimaryActionLabel({ domain: 'lsat', path: '/lsat/practice', sessionStatus: 'none' })).toBe('Start activity');
    expect(todayHeroTitle({
      domain: 'lsat',
      title: 'Practice an LSAT section',
      sessionStatus: 'paused',
      sessionDomain: 'lsat',
    })).toBe('Resume LSAT section');
    expect(todayHeroTitle({
      domain: 'cfa',
      title: 'Continue studying',
      sessionStatus: 'paused',
      sessionDomain: 'lsat',
    })).toBe('Continue studying');
  });
});
