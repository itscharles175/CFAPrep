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
import { render, screen, within } from '@testing-library/react';
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
    const input = screen.getByRole('combobox', { name: /search modules, formulas, topics with the command palette/i });
    expect(input).toHaveAttribute('placeholder', 'Search');
    expect(screen.getByLabelText('Control K')).toBeVisible();
    unmount();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });
});
