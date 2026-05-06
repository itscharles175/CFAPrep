import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  EmptyPanel,
  IconFrame,
  MetricTile,
  PageHeader,
  PageSection,
  Panel,
  SegmentedControl,
  StatCell,
  StatGrid,
  StatusBadge,
  Surface,
} from './Primitives';

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

  it('renders shared cockpit layout primitives with stable semantic classes', () => {
    render(
      <PageSection title="Today" subtitle="Next action" actions={<button type="button">Export</button>}>
        <Panel title="Readiness" eyebrow="local" icon={IconFrame} tone="vault" status="vault">
          <StatGrid columns={2}>
            <StatCell label="Queue" value="4" detail="due" tone="vault" />
            <StatCell label="Mastery" value="82%" tone="success" />
          </StatGrid>
        </Panel>
        <EmptyPanel title="No rows" description="Nothing to review." />
      </PageSection>,
    );

    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByText('Readiness').closest('.panel')).toHaveClass('surface-status-vault');
    expect(screen.getByText('Queue').closest('.stat-cell')).toHaveClass('stat-cell-vault');
    expect(screen.getByText('No rows').closest('.empty-panel')).toBeInTheDocument();
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

    screen.getByRole('radio', { name: 'Topic' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenCalledWith('mock');
  });
});
