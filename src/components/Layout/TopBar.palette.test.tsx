/*
 * K4-cmd / K4-13 — unified ⌘K palette (host TopBar).
 *
 * The LSAT vocabulary is folded into the host palette unconditionally (the
 * `LSAT_UNIFIED_SHELL` flag was removed in the K4-13 cutover): the LSAT routes
 * surface as first-class, `external`, /lsat-prefixed rows (badged "LSAT"),
 * navigable from one ⌘K.
 *
 * The TopBar pulls in a lot of host context (theme, progress, catalog, content
 * search); we stub those to isolate the palette composition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// --- Stub the heavy host dependencies the palette doesn't exercise here. ----
vi.mock('../../data/catalog', () => ({ buildSearchItems: () => [] }));
vi.mock('../../lib/cfaSourceVault', () => ({ searchCfaSourceVault: vi.fn().mockResolvedValue([]) }));
vi.mock('../../lib/contentSearch', () => ({ searchAllContent: vi.fn().mockResolvedValue([]) }));
vi.mock('../../lib/learning', () => ({ exportVaultData: vi.fn(), repairVaultData: vi.fn() }));
vi.mock('../../hooks/useProgress', () => ({ useProgressSummary: () => ({ upcomingReviews: [] }) }));
vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', cycleTheme: vi.fn() }) }));
vi.mock('../../domains/cfa/useLevel3Pathway', () => ({ useLevel3Pathway: () => ['', vi.fn()] }));
vi.mock('../../domains/cfa/cfaLevel3Pathways', () => ({ level3TopicBelongsToPathway: () => true }));
vi.mock('./NotificationCenter', () => ({ NotificationCenter: () => null }));

import TopBar from './TopBar';

function renderTopBar(path = '/lsat/practice') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
    </MemoryRouter>,
  );
}

async function openPalette() {
  const input = screen.getByRole('combobox', { name: /command palette/i });
  await userEvent.click(input);
  return input;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  delete window.studyvault;
});

describe('unified palette', () => {
  it('surfaces LSAT routes as first-class palette rows', async () => {
    renderTopBar();
    const input = await openPalette();
    await userEvent.type(input, 'srs');
    const listbox = screen.getByRole('listbox', { name: /command palette results/i });
    // The SRS LSAT route now appears, badged as an LSAT result.
    expect(within(listbox).getByText('SRS')).toBeInTheDocument();
  });

  it('uses LSAT vocabulary for search scope and empty results', async () => {
    renderTopBar();
    const input = await openPalette();

    expect(input).toHaveAttribute('placeholder', 'Search LSAT questions, passages, sources, and notes…');
    await userEvent.type(input, 'no-such-lsat-destination');

    const listbox = screen.getByRole('listbox', { name: /command palette results/i });
    await waitFor(() => expect(within(listbox).getByText('No matching LSAT content or destinations.')).toBeInTheDocument());
  });

  it('opens the LSAT keyboard help event from the shared toolbar', async () => {
    const onLsatHelp = vi.fn();
    const onHostHelp = vi.fn();
    window.addEventListener('lsatlab:keyboard-help', onLsatHelp);
    window.addEventListener('quantvault:keyboard-help', onHostHelp);

    renderTopBar('/lsat/practice');
    await userEvent.click(screen.getByRole('button', { name: 'Open keyboard shortcuts help' }));

    expect(onLsatHelp).toHaveBeenCalledOnce();
    expect(onHostHelp).not.toHaveBeenCalled();
    window.removeEventListener('lsatlab:keyboard-help', onLsatHelp);
    window.removeEventListener('quantvault:keyboard-help', onHostHelp);
  });

  it('keeps the command list out of the tab order while supporting active-descendant navigation', async () => {
    renderTopBar('/lsat/practice');
    await openPalette();

    expect(screen.getByRole('listbox', { name: /command palette results/i })).toHaveAttribute('tabindex', '-1');
  });

  it('dismisses notifications when focus moves to content outside the popover', async () => {
    renderTopBar('/lsat/practice');
    const trigger = screen.getByRole('button', { name: 'Notifications' });
    await userEvent.click(trigger);
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('names the selected curriculum and scopes the palette copy on a neutral route', () => {
    localStorage.setItem(
      'studyvault:study-context:v1',
      JSON.stringify({ domain: 'cfa', cfaLevel: 'level3', goal: 'exam-readiness' }),
    );

    renderTopBar('/preferences');

    expect(screen.getByRole('status', { name: /selected study context: cfa.*level iii/i })).toHaveTextContent(
      /studying cfa.*level iii/i,
    );
    expect(screen.getByRole('combobox', { name: /command palette/i })).toHaveAttribute(
      'placeholder',
      'Search CFA · Level III material…',
    );
  });

  it('uses the native Command shortcut glyph when the desktop bridge is present', () => {
    Object.defineProperty(window, 'studyvault', { configurable: true, value: {} });

    renderTopBar('/cfa');

    expect(screen.getByLabelText('Command K')).toHaveTextContent('⌘K');
  });

  it('uses the Command shortcut on a Mac platform without a desktop bridge', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });

    renderTopBar('/cfa');

    expect(screen.getByLabelText('Command K')).toHaveTextContent('⌘K');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
  });

  it('uses the Command shortcut for a Mac user agent when platform is unavailable', () => {
    const originalPlatform = navigator.platform;
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
    });

    renderTopBar('/cfa');

    expect(screen.getByLabelText('Command K')).toHaveTextContent('⌘K');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
  });

  it('restores the shortcut origin after Escape closes the palette', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/cfa/level3/mock']}>
        <button type="button">Return target</button>
        <TopBar />
      </MemoryRouter>,
    );
    const returnTarget = screen.getByRole('button', { name: 'Return target' });
    returnTarget.focus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.getByRole('combobox', { name: /command palette/i })).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(returnTarget).toHaveFocus());
    expect(container.querySelector('.search-popover')).toBeNull();
  });

  it('puts the current CFA Level III route ahead of other CFA levels by default', async () => {
    localStorage.setItem(
      'studyvault:study-context:v1',
      JSON.stringify({ domain: 'cfa', cfaLevel: 'level3', goal: 'balanced' }),
    );
    renderTopBar('/cfa/level3/mock');

    await openPalette();
    const options = screen.getAllByRole('option');
    expect(within(options[0]).getByText('Start Level III Mock')).toBeInTheDocument();
  });

  it('shows the CFA scope when a cross-domain mock match is searched from LSAT', async () => {
    renderTopBar('/lsat/practice');
    const input = await openPalette();
    await userEvent.type(input, 'mock');

    const listbox = screen.getByRole('listbox', { name: /command palette results/i });
    await waitFor(() => expect(within(listbox).getByText('Start Level I Mock')).toBeInTheDocument());
    expect(within(listbox).getByText('CFA results')).toBeInTheDocument();
    const mockOption = within(listbox).getByRole('option', { name: /Start Level I Mock/i });
    expect(within(mockOption).getByText('CFA')).toBeInTheDocument();
  });

  it('marks the measured 960px desktop range as compact before controls can overlap', () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(min-width: 901px) and (max-width: 1179px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const { container, unmount } = renderTopBar('/lsat/practice');
    expect(container.querySelector('header.topbar')).toHaveClass('topbar--compact');
    const input = screen.getByRole('combobox', { name: /search lsat questions, passages, sources, and notes with the command palette/i });
    expect(input).toHaveAttribute('placeholder', 'Search');
    expect(screen.getByLabelText('Control K')).toBeVisible();
    unmount();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });
});
