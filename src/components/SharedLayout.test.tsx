/*
 * K4-6 / K4-13 — render tests for the unified host shell.
 *
 * The unified shell is the only shell as of the K4-13 cutover (the
 * `LSAT_UNIFIED_SHELL` flag was removed), so these pin its unconditional
 * contract: <SharedLayout> mounts the host shell with the LSAT 4th Sidebar
 * section (built from `lsatAppRoutes`, grouped by navGroup) AND the TopBar
 * study/test mode toggle, and renders its children.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SharedLayout from './SharedLayout';
import { ThemeProvider } from '../context/ThemeContext';
import { clearHistory } from '../lib/navigationHistory';

function renderWithShell(node: React.ReactNode, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>{node}</ThemeProvider>
    </MemoryRouter>,
  );
}

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  localStorage.clear();
  clearHistory();
});

afterEach(() => {
  localStorage.clear();
  clearHistory();
  vi.restoreAllMocks();
});

describe('SharedLayout (K4-6) — unified shell', () => {
  it('mounts the host shell with the six workspace links and renders children', () => {
    renderWithShell(<SharedLayout>{<div>Routed content</div>}</SharedLayout>);

    // Host chrome is present (sidebar brand + main region).
    expect(screen.getByText('Routed content')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Learn' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Practice' })).toHaveAttribute('href', '/cfa/level1/mock');
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Progress' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Library' })).toBeInTheDocument();
  });

  it('expands the LSAT section to reveal grouped rows from lsatAppRoutes', async () => {
    renderWithShell(<SharedLayout />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'lsat');
    await user.click(screen.getByRole('link', { name: /^LSAT/i }));
    // A representative LSAT row from the merged manifest appears, /lsat-prefixed.
    const srs = await screen.findByRole('link', { name: 'SRS' });
    expect(srs).toHaveAttribute('href', '/lsat/srs');
    // Grouped headings (Practice / Insight / Setup) are present. ("Practice" is
    // also a route label, so scope to the section-label heading specifically.)
    const headings = screen.getAllByText('Insight');
    expect(headings.length).toBeGreaterThan(0);
    expect(headings[0]).toHaveClass('sidebar-section-label');
    // The Setup group's 'Settings' row resolves to its /lsat path too.
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/lsat/settings');
  });

  it('renders the TopBar study/test mode toggle and switches mode', async () => {
    renderWithShell(<SharedLayout />);
    const user = userEvent.setup();
    const group = screen.getByRole('group', { name: 'App mode' });
    const study = within(group).getByRole('button', { name: 'Study' });
    const test = within(group).getByRole('button', { name: 'Test' });
    // Default is Study.
    expect(study).toHaveAttribute('aria-pressed', 'true');
    await user.click(test);
    expect(test).toHaveAttribute('aria-pressed', 'true');
    expect(study).toHaveAttribute('aria-pressed', 'false');
  });

  it('routes CFA practice and topic links through the selected target level', async () => {
    renderWithShell(<SharedLayout />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'level2');
    expect(screen.getByRole('link', { name: 'Practice' })).toHaveAttribute('href', '/cfa/level2/mock');

    await user.click(screen.getByRole('link', { name: 'CFA Level II' }));
    const levelTwoTopic = screen.getAllByRole('link').find((link) => link.getAttribute('href')?.startsWith('/cfa/level2/'));
    expect(levelTwoTopic).toBeDefined();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Level' }), 'level3');
    expect(screen.getByRole('combobox', { name: 'Pathway' })).toBeInTheDocument();
  });

  it('Test Mode hides the LSAT hideInTest rows in the Sidebar section', async () => {
    renderWithShell(<SharedLayout />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Track' }), 'lsat');
    await user.click(within(screen.getByRole('group', { name: 'App mode' })).getByRole('button', { name: 'Test' }));
    await user.click(screen.getByRole('link', { name: /^LSAT/i }));
    // 'Practice' (not hideInTest) survives; 'SRS' (hideInTest) is hidden.
    expect((await screen.findAllByRole('link', { name: 'Practice' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'SRS' })).toBeNull();
  });

  it('moves focus into the mobile nav, closes on Escape, and returns focus to the menu button', async () => {
    installMatchMedia(true);
    renderWithShell(<SharedLayout />, '/lsat/srs');
    const user = userEvent.setup();
    const menuButton = screen.getByTitle('Open navigation');
    const hiddenSidebar = document.querySelector('#main-sidebar');

    expect(hiddenSidebar).toHaveAttribute('hidden');
    await user.click(menuButton);

    const openSidebar = screen.getByRole('complementary', { name: /main navigation sidebar/i });
    expect(openSidebar).not.toHaveAttribute('hidden');
    await waitFor(() => expect(openSidebar.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');

    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('#main-sidebar')).toHaveAttribute('hidden');
    expect(menuButton).toHaveFocus();
  });
});
