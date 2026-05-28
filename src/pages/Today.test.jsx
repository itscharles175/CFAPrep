import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/studyDirector', () => ({
  buildStudyPlan: vi.fn(),
}));

import { buildStudyPlan } from '../lib/studyDirector';
import Today from './Today';

function renderToday() {
  return render(
    <MemoryRouter>
      <Today />
    </MemoryRouter>,
  );
}

describe('Today focus-mode landing', () => {
  it('renders the loading state before the plan resolves', async () => {
    buildStudyPlan.mockReturnValue(new Promise(() => undefined)); // never resolves
    renderToday();
    expect(await screen.findByText(/Loading your plan/i)).toBeInTheDocument();
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

    expect(await screen.findByText('2 reviews due, 1 weak topic to shore up')).toBeInTheDocument();
    expect(screen.getByText('Modified duration')).toBeInTheDocument();
    expect(screen.getByText(/Topic readiness is only 58%/)).toBeInTheDocument();
    expect(screen.getByText('Upcoming review spike')).toBeInTheDocument();
    expect(screen.getByText(/Peak 2026-05-30/)).toBeInTheDocument();

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
    await waitFor(() => expect(screen.getByText('No urgent items — great progress!')).toBeInTheDocument());
    expect(screen.getByText('Continue studying')).toBeInTheDocument();
  });
});
