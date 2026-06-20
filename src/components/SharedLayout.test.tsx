/*
 * K4-6 / K4-13 — render tests for the unified host shell.
 *
 * The unified shell is the only shell as of the K4-13 cutover (the
 * `LSAT_UNIFIED_SHELL` flag was removed), so these pin its unconditional
 * contract: <SharedLayout> mounts the host shell with the LSAT 4th Sidebar
 * section (built from `lsatAppRoutes`, grouped by navGroup) AND the TopBar
 * study/test mode toggle, and renders its children.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

beforeEach(() => {
  localStorage.clear();
  clearHistory();
});

afterEach(() => {
  localStorage.clear();
  clearHistory();
});

describe('SharedLayout (K4-6) — unified shell', () => {
  it('mounts the host shell with the LSAT section and renders children', () => {
    renderWithShell(<SharedLayout>{<div>Routed content</div>}</SharedLayout>);

    // Host chrome is present (sidebar brand + main region).
    expect(screen.getByText('Routed content')).toBeInTheDocument();
    // The LSAT 4th section header (collapsed-by-default toggle) is rendered.
    expect(screen.getByRole('link', { name: /LSAT/i })).toBeInTheDocument();
  });

  it('expands the LSAT section to reveal grouped rows from lsatAppRoutes', async () => {
    renderWithShell(<SharedLayout />);
    const user = userEvent.setup();
    // Expand the section (collapsed by default off the /lsat plane).
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

  it('Test Mode hides the LSAT hideInTest rows in the Sidebar section', async () => {
    renderWithShell(<SharedLayout />);
    const user = userEvent.setup();
    // Switch to Test Mode, then expand the LSAT section.
    await user.click(within(screen.getByRole('group', { name: 'App mode' })).getByRole('button', { name: 'Test' }));
    await user.click(screen.getByRole('link', { name: /^LSAT/i }));
    // 'Practice' (not hideInTest) survives; 'SRS' (hideInTest) is hidden.
    expect(await screen.findByRole('link', { name: 'Practice' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'SRS' })).toBeNull();
  });
});
