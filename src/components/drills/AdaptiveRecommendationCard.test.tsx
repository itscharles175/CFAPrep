import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdaptiveRecommendationCard } from './AdaptiveRecommendationCard';
import type { NextQuestionCandidate, NextQuestionsReport } from '../../hooks/useNextQuestions';

function candidate(overrides: Partial<NextQuestionCandidate> = {}): NextQuestionCandidate {
  return {
    contentId: 'cfa:question:ethics-1',
    key: 'Ethics: Standard I',
    domain: 'cfa',
    masteryFraction: 0.55,
    difficultyEstimate: 3,
    expectedSuccess: 0.6,
    zpdFit: 0.9,
    utilityScore: 0.5,
    reason: 'maximum_information',
    leech: false,
    attempts: 4,
    ...overrides,
  };
}

function report(overrides: Partial<NextQuestionsReport> = {}): NextQuestionsReport {
  return {
    reachable: true,
    domain: 'cfa',
    recommendations: [candidate()],
    strategy: 'zpd_repair',
    mastery: 0.55,
    detail: 'Ranked 1 next objective.',
    ...overrides,
  };
}

describe('AdaptiveRecommendationCard', () => {
  it('renders the labelled region with the strategy', () => {
    render(<AdaptiveRecommendationCard report={report()} />);
    expect(screen.getByRole('region', { name: 'Adaptive next objectives' })).toBeInTheDocument();
    // The selector strategy is shown (underscores humanized).
    expect(screen.getByText('zpd repair')).toBeInTheDocument();
  });

  it('lists ranked candidates with their reason and predicted success', () => {
    render(
      <AdaptiveRecommendationCard
        report={report({
          recommendations: [
            candidate({ key: 'Ethics: Standard I', reason: 'recent_gap_review', expectedSuccess: 0.3, leech: true }),
            candidate({ contentId: 'cfa:question:quant-2', key: 'Quant: TVM', reason: 'fluency_check', expectedSuccess: 0.85 }),
          ],
        })}
      />,
    );
    const list = screen.getByRole('list', { name: 'Recommended next objectives' });
    expect(list).toBeInTheDocument();
    expect(screen.getByText('Ethics: Standard I')).toBeInTheDocument();
    expect(screen.getByText('Quant: TVM')).toBeInTheDocument();
    // Shared reason vocabulary surfaces as readable labels.
    expect(screen.getByText('Gap repair')).toBeInTheDocument();
    expect(screen.getByText('Fluency check')).toBeInTheDocument();
    // Predicted success rendered as a percent.
    expect(screen.getByText('success 30%')).toBeInTheDocument();
    expect(screen.getByText('success 85%')).toBeInTheDocument();
    // The leech flag surfaces.
    expect(screen.getByText('leech')).toBeInTheDocument();
  });

  it('respects maxItems', () => {
    render(
      <AdaptiveRecommendationCard
        maxItems={1}
        report={report({
          recommendations: [
            candidate({ key: 'First' }),
            candidate({ contentId: 'cfa:question:b', key: 'Second' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('invokes onSelect with the candidate when a row is clicked', async () => {
    const onSelect = vi.fn();
    const only = candidate({ key: 'Ethics: Standard I' });
    render(<AdaptiveRecommendationCard report={report({ recommendations: [only] })} onSelect={onSelect} />);
    // With onSelect the row is a button.
    await userEvent.click(screen.getByRole('button', { name: /Study Ethics: Standard I/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(only);
  });

  it('renders static (non-button) rows when onSelect is omitted', () => {
    render(<AdaptiveRecommendationCard report={report()} />);
    // No per-row study button without onSelect.
    expect(screen.queryByRole('button', { name: /Study / })).not.toBeInTheDocument();
  });

  it('shows an offline note when the report is unreachable', () => {
    render(<AdaptiveRecommendationCard report={report({ reachable: false, recommendations: [] })} />);
    expect(screen.getByText(/LSAT backend is offline/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Recommended next objectives' })).not.toBeInTheDocument();
  });

  it('shows an empty state when reachable but no recommendations', () => {
    render(<AdaptiveRecommendationCard report={report({ recommendations: [], detail: 'none' })} />);
    expect(screen.getByText(/answer a few more questions/i)).toBeInTheDocument();
  });

  it('shows a loading note before the first report resolves', () => {
    render(<AdaptiveRecommendationCard report={null} loading />);
    expect(screen.getByRole('status')).toHaveTextContent(/Routing your next objectives/);
  });

  it('calls onRefresh and disables the button while loading', async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <AdaptiveRecommendationCard report={report()} onRefresh={onRefresh} loading={false} />,
    );
    const button = screen.getByRole('button', { name: /Refresh/ });
    await userEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<AdaptiveRecommendationCard report={report()} onRefresh={onRefresh} loading />);
    expect(screen.getByRole('button', { name: /Routing…/ })).toBeDisabled();
  });
});
