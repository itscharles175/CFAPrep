import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  WeaknessIndexCardView,
  type WeaknessIndexCardViewProps,
} from './WeaknessIndexCard';
import type { WeaknessIndexItem } from '../../hooks/useWeaknessIndex';

// Mock the hook so the self-contained <WeaknessIndexCard> can be exercised
// without a network round-trip. Each test sets the return value.
const useWeaknessIndexMock = vi.fn();
vi.mock('../../hooks/useWeaknessIndex', () => ({
  useWeaknessIndex: (...args: unknown[]) => useWeaknessIndexMock(...args),
}));

function makeItem(overrides: Partial<WeaknessIndexItem> = {}): WeaknessIndexItem {
  return {
    domain: 'lsat',
    key: 'Flaw',
    label: 'Flaw',
    sectionType: 'LR',
    accuracy: 0.42,
    mastery: 0.45,
    lowerBound: 0.31,
    attempts: 18,
    trend: 'down',
    recentMissIds: ['101', '102', '103'],
    drillPath: '/lsat/analytics/type/Flaw',
    ...overrides,
  };
}

function renderView(props: Partial<WeaknessIndexCardViewProps> = {}) {
  const merged: WeaknessIndexCardViewProps = {
    items: [makeItem()],
    loading: false,
    refreshing: false,
    reachable: true,
    fetchedAt: '2026-06-16T08:00:00Z',
    onRefresh: () => {},
    ...props,
  };
  return render(
    <MemoryRouter>
      <WeaknessIndexCardView {...merged} />
    </MemoryRouter>,
  );
}

describe('WeaknessIndexCardView', () => {
  it('renders the heading and the total weakness count', () => {
    renderView({
      items: [makeItem(), makeItem({ key: 'Inference', label: 'Inference' })],
    });
    expect(screen.getByText('Weakest Areas')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders a ranked row with accuracy, floor, attempts, and recent-miss count', () => {
    renderView({ items: [makeItem()] });
    const row = screen.getByRole('link', { name: /Flaw/ });
    expect(row).toHaveAttribute('href', '/lsat/analytics/type/Flaw');
    const meta = within(screen.getByRole('listitem')).getByText(/accuracy/);
    expect(meta).toHaveTextContent('42% accuracy');
    expect(meta).toHaveTextContent('floor 31%');
    expect(meta).toHaveTextContent('18 attempts');
    expect(meta).toHaveTextContent('3 recent misses');
  });

  it('deep-links host topics to the plane drill path with a domain chip', () => {
    renderView({
      items: [
        makeItem({
          domain: 'cfa',
          key: 'ethics',
          label: 'Ethics',
          sectionType: null,
          drillPath: '/cfa/drills?topic=ethics',
        }),
      ],
    });
    const row = screen.getByRole('link', { name: /Ethics/ });
    expect(row).toHaveAttribute('href', '/cfa/drills?topic=ethics');
    expect(within(row).getByText('CFA')).toBeInTheDocument();
  });

  it('renders an em dash when accuracy or floor is null', () => {
    renderView({
      items: [makeItem({ accuracy: null, lowerBound: null, recentMissIds: [] })],
    });
    const meta = within(screen.getByRole('listitem')).getByText(/accuracy/);
    expect(meta).toHaveTextContent('— accuracy');
    expect(meta).toHaveTextContent('floor —');
  });

  it('caps the rendered rows at maxRows', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      makeItem({ key: `T${i}`, label: `Type ${i}` }),
    );
    renderView({ items, maxRows: 3 });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    // The count chip still reflects the FULL list, not the truncated view.
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('shows a loading state without rows', () => {
    renderView({ items: [], loading: true, fetchedAt: null });
    expect(screen.getByText('Loading weakness index…')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('shows an offline hint when the sidecar is unreachable', () => {
    renderView({ items: [], reachable: false, fetchedAt: null });
    expect(screen.getByText(/LSAT backend is offline/)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no weak areas', () => {
    renderView({ items: [] });
    expect(screen.getByText(/No weak areas yet/)).toBeInTheDocument();
  });

  it('calls onRefresh when the refresh button is clicked', async () => {
    const onRefresh = vi.fn();
    renderView({ onRefresh });
    await userEvent.click(screen.getByRole('button', { name: /Refresh weakness index/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the refresh button while refreshing', () => {
    renderView({ refreshing: true });
    expect(screen.getByRole('button', { name: /Refreshing weakness index/ })).toBeDisabled();
  });

  it('renders the reliability-floor footnote only when fetched and reachable', () => {
    const { rerender } = renderView({ fetchedAt: '2026-06-16T08:00:00Z' });
    expect(screen.getByText(/Ranked by reliability floor/)).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <WeaknessIndexCardView
          items={[]}
          loading={false}
          refreshing={false}
          reachable={false}
          fetchedAt={null}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Ranked by reliability floor/)).not.toBeInTheDocument();
  });
});

describe('WeaknessIndexCard (self-contained)', () => {
  beforeEach(() => {
    useWeaknessIndexMock.mockReset();
  });

  it('wires the hook and renders the ranked rows', async () => {
    const { WeaknessIndexCard } = await import('./WeaknessIndexCard');
    useWeaknessIndexMock.mockReturnValue({
      items: [makeItem()],
      meta: null,
      loading: false,
      refreshing: false,
      reachable: true,
      fetchedAt: '2026-06-16T08:00:00Z',
      refresh: vi.fn(),
    });
    render(
      <MemoryRouter>
        <WeaknessIndexCard />
      </MemoryRouter>,
    );
    expect(screen.getByText('Weakest Areas')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Flaw/ })).toBeInTheDocument();
  });

  it('forwards hook options through to useWeaknessIndex', async () => {
    const { WeaknessIndexCard } = await import('./WeaknessIndexCard');
    useWeaknessIndexMock.mockReturnValue({
      items: [],
      meta: null,
      loading: false,
      refreshing: false,
      reachable: true,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    const options = { domain: 'host' as const, days: 30, limit: 6 };
    render(
      <MemoryRouter>
        <WeaknessIndexCard options={options} />
      </MemoryRouter>,
    );
    expect(useWeaknessIndexMock).toHaveBeenCalledWith(options);
  });
});
