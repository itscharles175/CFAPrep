import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import NavigationBreadcrumb from './NavigationBreadcrumb';
import DomainIndicator from './DomainIndicator';
import NavBackButton from './NavBackButton';
import { clearHistory, pushHistory } from '../lib/navigationHistory';

beforeEach(() => {
  clearHistory();
  vi.clearAllMocks();
});

afterEach(() => {
  clearHistory();
});

function renderAt(node: ReactNode, path: string) {
  return render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

describe('NavigationBreadcrumb (UX-4)', () => {
  it('renders an accessible breadcrumb nav with aria-current on the last crumb', () => {
    renderAt(<NavigationBreadcrumb />, '/analytics');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    const current = screen.getByText('Analytics');
    expect(current).toHaveAttribute('aria-current', 'page');
    // The Dashboard root is a link, not the current page.
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders nothing at the host root (single crumb)', () => {
    const { container } = renderAt(<NavigationBreadcrumb />, '/');
    expect(container.querySelector('nav')).toBeNull();
  });
});

describe('DomainIndicator (UX-4)', () => {
  it('announces the active plane with role=status + descriptive aria-label', () => {
    renderAt(<DomainIndicator />, '/cfa/level1/fixed-income');
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('aria-label', 'Active domain: CFA Program');
    expect(badge).toHaveTextContent('CFA');
  });

  it('falls back to StudyVault on a general route', () => {
    renderAt(<DomainIndicator />, '/calculators');
    expect(screen.getByRole('status')).toHaveTextContent('StudyVault');
  });
});

describe('NavBackButton (UX-4)', () => {
  it('is disabled at the root of the trail with a generic Back label', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    renderAt(<NavBackButton />, '/');
    const btn = screen.getByRole('button', { name: 'Back' });
    expect(btn).toBeDisabled();
  });

  it('names the previous destination in its aria-label and calls the same-domain navigator', async () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    pushHistory({ path: '/analytics', label: 'Analytics' });
    const onBack = vi.fn();
    renderAt(<NavBackButton onSameDomainBack={onBack} />, '/analytics');
    const btn = screen.getByRole('button', { name: 'Back to Dashboard' });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
