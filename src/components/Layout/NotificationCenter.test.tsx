import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NotificationCenter } from './NotificationCenter';
import type { CrossDomainNotificationsState } from '../../hooks/useProgress';

// The LSAT rows hard-hop across the app split via navigateDomain — mock it so the
// test can assert the cross-domain nav without a real History/CSS swap.
const navigateDomain = vi.fn();
vi.mock('../../lib/domainNav', () => ({
  navigateDomain: (to: string) => navigateDomain(to),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function state(overrides: Partial<CrossDomainNotificationsState> = {}): CrossDomainNotificationsState {
  return {
    notifications: [],
    total: 0,
    cfaCount: 0,
    lsatCount: 0,
    lsatAvailable: true,
    indexedDbAvailable: true,
    loading: false,
    ...overrides,
  };
}

function renderCenter(props: Parameters<typeof NotificationCenter>[0]) {
  return render(
    <MemoryRouter>
      <NotificationCenter {...props} />
    </MemoryRouter>,
  );
}

describe('NotificationCenter', () => {
  it('headlines the cross-domain count when both CFA and LSAT have due items', () => {
    renderCenter({
      state: state({
        cfaCount: 2,
        lsatCount: 1,
        total: 3,
        notifications: [
          { id: 'host:cfa:a', domain: 'cfa', title: 'Time value of money', path: '/cfa/level1/quant/quiz', dueAt: '2026-06-16T09:00:00.000Z' },
          { id: 'host:cfa:b', domain: 'cfa', title: 'Ethics standards', path: '/cfa/level1/ethics/quiz', dueAt: '2026-06-16T09:00:00.000Z' },
          { id: 'lsat:7', domain: 'lsat', title: 'Which one of the following weakens…', path: '/lsat/srs', dueAt: '2026-06-16T09:00:00.000Z', external: true },
        ],
      }),
    });
    expect(screen.getByText('3 reviews due across CFA + LSAT')).toBeInTheDocument();
    expect(screen.getByText('Time value of money')).toBeInTheDocument();
    expect(screen.getByText('Which one of the following weakens…')).toBeInTheDocument();
  });

  it('headlines a CFA-only count when the LSAT queue is empty', () => {
    renderCenter({
      state: state({
        cfaCount: 1,
        total: 1,
        notifications: [
          { id: 'host:cfa:a', domain: 'cfa', title: 'Discount rates', path: '/cfa/level1/quant/quiz', dueAt: '2026-06-16T09:00:00.000Z' },
        ],
      }),
    });
    expect(screen.getByText('1 CFA review due')).toBeInTheDocument();
  });

  it('hard-navigates across domains for an LSAT row and fires onNavigate', async () => {
    const onNavigate = vi.fn();
    renderCenter({
      onNavigate,
      state: state({
        lsatCount: 1,
        total: 1,
        notifications: [
          { id: 'lsat:7', domain: 'lsat', title: 'LSAT item 7', path: '/lsat/srs', external: true },
        ],
      }),
    });
    await userEvent.click(screen.getByRole('button', { name: /LSAT item 7/i }));
    expect(navigateDomain).toHaveBeenCalledWith('/lsat/srs');
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('renders host rows as in-router links (no cross-domain hop)', async () => {
    const onNavigate = vi.fn();
    renderCenter({
      onNavigate,
      state: state({
        cfaCount: 1,
        total: 1,
        notifications: [
          { id: 'host:cfa:a', domain: 'cfa', title: 'Bond pricing', path: '/cfa/level1/fixed-income/quiz', dueAt: '2026-06-16T09:00:00.000Z' },
        ],
      }),
    });
    const link = screen.getByRole('link', { name: /Bond pricing/i });
    expect(link).toHaveAttribute('href', '/cfa/level1/fixed-income/quiz');
    await userEvent.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(navigateDomain).not.toHaveBeenCalled();
  });

  it('shows a caught-up empty state when nothing is due', () => {
    renderCenter({ state: state() });
    expect(screen.getByText('No reviews due')).toBeInTheDocument();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it('shows a quiet offline hint when the LSAT sidecar is unavailable', () => {
    renderCenter({
      state: state({
        lsatAvailable: false,
        cfaCount: 1,
        total: 1,
        notifications: [
          { id: 'host:cfa:a', domain: 'cfa', title: 'Equity multiples', path: '/cfa/level1/equity/quiz', dueAt: '2026-06-16T09:00:00.000Z' },
        ],
      }),
    });
    expect(screen.getByText(/LSAT reviews are offline/i)).toBeInTheDocument();
    // Still renders the host row — degrade, don't error.
    expect(screen.getByText('Equity multiples')).toBeInTheDocument();
  });

  it('surfaces a local-data-unavailable message when IndexedDB read failed', () => {
    renderCenter({ state: state({ indexedDbAvailable: false }) });
    expect(screen.getByText(/Local study data is unavailable/i)).toBeInTheDocument();
  });

  it('shows a loading placeholder while the first fold resolves', () => {
    renderCenter({ state: state({ loading: true }) });
    expect(screen.getByText(/Checking for due reviews/i)).toBeInTheDocument();
  });
});
