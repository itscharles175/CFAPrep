/*
 * K4 cutover regression guard — <SharedLayout> must be self-sufficient host chrome.
 *
 * SharedLayout is the LSAT plane's chrome (host <Sidebar> + <TopBar>) and is the
 * ONLY place those render on /lsat (the host <App/>, which supplies
 * ThemeProvider/ToastProvider/OfflineProvider, is not mounted there). The cutover
 * bug this guards: SharedLayout rendered the host TopBar with NO host providers, so
 * TopBar's `useTheme()` threw "useTheme must be used inside ThemeProvider" and
 * blanked every /lsat page. The fix wraps SharedLayout's tree in the host provider
 * stack — so this test renders SharedLayout WITHOUT any ancestor provider and
 * asserts the chrome still mounts.
 *
 * The heavy TopBar/Sidebar data deps are stubbed (as in TopBar.palette.test.tsx);
 * the THREE host context providers are deliberately left REAL — they are the thing
 * under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stub the heavy data deps the chrome pulls in (kept identical in spirit to the
// palette test). NOTE: we do NOT mock ThemeContext/ToastContext/OfflineContext —
// SharedLayout must provide those itself, which is exactly the regression.
vi.mock('../data/catalog', () => ({
  buildSearchItems: () => [],
  cfaTopics: [],
  excelModules: [],
  quantModules: [],
}));
vi.mock('../lib/cfaSourceVault', () => ({ searchCfaSourceVault: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/contentSearch', () => ({ searchAllContent: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/learning', () => ({ exportVaultData: vi.fn(), repairVaultData: vi.fn() }));
vi.mock('../hooks/useProgress', () => ({ useProgressSummary: () => ({ upcomingReviews: [] }) }));
vi.mock('../domains/cfa/useLevel3Pathway', () => ({ useLevel3Pathway: () => ['', vi.fn()] }));
vi.mock('../domains/cfa/cfaLevel3Pathways', () => ({ level3TopicBelongsToPathway: () => true }));
vi.mock('./Layout/NotificationCenter', () => ({ NotificationCenter: () => null }));

import SharedLayout from './SharedLayout';

afterEach(() => {
  vi.clearAllMocks();
  document.body.removeAttribute('data-domain');
});

describe('SharedLayout (unified LSAT chrome)', () => {
  it('mounts the host chrome WITHOUT any ancestor provider (self-provides ThemeProvider et al.)', () => {
    // No <ThemeProvider> wrapper here — if SharedLayout did not self-provide the
    // host contexts, TopBar's useTheme() would throw and this render would fail.
    render(
      <MemoryRouter initialEntries={['/lsat/srs']}>
        <SharedLayout>
          <div>shared-child</div>
        </SharedLayout>
      </MemoryRouter>,
    );

    // Children render inside the shell.
    expect(screen.getByText('shared-child')).toBeInTheDocument();
    // The host TopBar mounted (its command palette input) — proves useTheme()
    // resolved against a provider SharedLayout supplied.
    expect(screen.getByRole('combobox', { name: /command palette/i })).toBeInTheDocument();
    // The same mobile workspace map follows the LSAT plane through SharedLayout.
    expect(screen.getByRole('navigation', { name: /study workspaces/i })).toBeInTheDocument();
  });

  it('stamps the LSAT domain accent on <body> for /lsat routes', () => {
    render(
      <MemoryRouter initialEntries={['/lsat/srs']}>
        <SharedLayout>
          <div>shared-child</div>
        </SharedLayout>
      </MemoryRouter>,
    );
    expect(document.body.getAttribute('data-domain')).toBe('lsat');
  });
});
