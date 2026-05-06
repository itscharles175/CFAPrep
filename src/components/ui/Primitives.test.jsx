import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MetricTile, PageHeader, SegmentedControl, StatusBadge, Surface } from './Primitives';

describe('cockpit primitives', () => {
  it('renders page headers, status badges, and metric tiles with semantic cockpit classes', () => {
    render(
      <PageHeader
        tone="exam"
        badge="CFA cockpit"
        title="Exam Desk"
        subtitle="Focused local study"
        meta={<StatusBadge tone="success">ready</StatusBadge>}
        actions={<button type="button">Start</button>}
      />,
    );

    expect(screen.getByRole('banner')).toHaveClass('page-header-exam');
    expect(screen.getByRole('heading', { name: 'Exam Desk' })).toBeInTheDocument();
    expect(screen.getByText('CFA cockpit')).toHaveClass('status-badge');
    expect(screen.getByText('ready')).toHaveClass('status-badge-success');

    render(<MetricTile label="Questions" value="120" detail="answered" tone="exam" />);
    expect(screen.getByText('Questions')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
  });

  it('supports interactive surfaces without changing router behavior', () => {
    render(
      <MemoryRouter>
        <Surface as="a" href="/review" interactive tone="vault">
          Review queue
        </Surface>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Review queue' })).toHaveClass('surface-interactive');
  });

  it('uses roving keyboard behavior for segmented controls', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Mode"
        value="topic"
        onChange={onChange}
        options={[
          { value: 'topic', label: 'Topic' },
          { value: 'mock', label: 'Mock' },
          { value: 'formula', label: 'Formula' },
        ]}
      />,
    );

    screen.getByRole('tab', { name: 'Topic' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenCalledWith('mock');
  });
});
