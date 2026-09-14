import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    const current = screen.getByText('Analytics').closest('[aria-current="page"]');
    if (!current) throw new Error('Expected Analytics to have an aria-current breadcrumb parent.');
    const currentBreadcrumb = current as HTMLElement;
    expect(currentBreadcrumb).toHaveAttribute('aria-current', 'page');
    expect(currentBreadcrumb.querySelector('.breadcrumb-current-label')).toHaveTextContent('Analytics');
    // Workspace-first chrome keeps Progress as the ancestor for Analytics.
    expect(screen.getByRole('link', { name: 'Progress' })).toHaveAttribute('href', '/analytics');
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
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
    pushHistory({ path: '/', label: 'Today' });
    renderAt(<NavBackButton />, '/');
    const btn = screen.getByRole('button', { name: 'Back' });
    expect(btn).toBeDisabled();
  });

  it('names the previous destination, calls the same-domain navigator, and restores landmark focus', async () => {
    pushHistory({ path: '/', label: 'Today' });
    pushHistory({ path: '/analytics', label: 'Analytics' });
    const onBack = vi.fn();
    renderAt(<><main id="main" tabIndex={-1} /><NavBackButton onSameDomainBack={onBack} /></>, '/analytics');
    const btn = screen.getByRole('button', { name: 'Back to Today' });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onBack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });
});
