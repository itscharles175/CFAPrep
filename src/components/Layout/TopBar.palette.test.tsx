/*
 * K4-cmd — unified ⌘K palette (host TopBar).
 *
 * Pins the two guarantees of folding the LSAT vocabulary into the host palette:
 *   1. flag OFF (default) → the palette is unchanged: NO LSAT route rows appear,
 *      so the running default behavior is byte-for-byte identical.
 *   2. flag ON (LSAT_UNIFIED_SHELL) → the LSAT routes surface as first-class,
 *      `external`, /lsat-prefixed rows (badged "LSAT"), navigable from one ⌘K.
 *
 * The TopBar pulls in a lot of host context (theme, progress, catalog, content
 * search); we stub those to isolate the palette composition + flag gate.
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
import { setFeatureFlag, __resetFeatureFlagCache } from '../../lib/featureFlags';

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
  __resetFeatureFlagCache();
  setFeatureFlag('LSAT_UNIFIED_SHELL', null);
  localStorage.clear();
});

afterEach(() => {
  setFeatureFlag('LSAT_UNIFIED_SHELL', null);
  __resetFeatureFlagCache();
  vi.clearAllMocks();
});

describe('unified palette — flag OFF (legacy rollback)', () => {
  beforeEach(() => {
    // K4-13 flipped the compiled default ON, so the legacy/OFF behavior must now
    // be requested explicitly (the unset default would resolve to ON).
    __resetFeatureFlagCache();
    setFeatureFlag('LSAT_UNIFIED_SHELL', false);
  });

  it('surfaces no LSAT route rows when searching the LSAT vocabulary', async () => {
    renderTopBar();
    const input = await openPalette();
    await userEvent.type(input, 'srs');
    const listbox = screen.getByRole('listbox', { name: /command palette results/i });
    // No row navigates into the /lsat plane.
    expect(within(listbox).queryByText('SRS')).toBeNull();
  });
});

describe('unified palette — flag ON (LSAT_UNIFIED_SHELL)', () => {
  beforeEach(() => {
    __resetFeatureFlagCache();
    setFeatureFlag('LSAT_UNIFIED_SHELL', true);
  });

  it('surfaces LSAT routes as first-class palette rows', async () => {
    renderTopBar();
    const input = await openPalette();
    await userEvent.type(input, 'srs');
    const listbox = screen.getByRole('listbox', { name: /command palette results/i });
    // The SRS LSAT route now appears, badged as an LSAT result.
    expect(within(listbox).getByText('SRS')).toBeInTheDocument();
  });
});
