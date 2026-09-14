import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiRow } from './KpiRow';

describe('KpiRow evidence states', () => {
  it('does not present zeroes as learner performance when no evidence exists', () => {
    render(
      <KpiRow
        predictedScore={null}
        scoreDelta30d={null}
        accuracy={0}
        avgTimeMsPerQ={0}
        brGap={0}
        trend={[]}
        hasAttempts={false}
        hasScoreHistory={false}
        hasBlindReview={false}
      />,
    );

    expect(screen.getAllByText('n/a')).toHaveLength(4);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
    expect(screen.queryByText('0pts')).not.toBeInTheDocument();
    expect(screen.getByText('Complete a timed section to establish pace.')).toBeInTheDocument();
    expect(screen.getByText('Complete blind review to measure the gap.')).toBeInTheDocument();
  });
});
