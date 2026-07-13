/*
 * AUDIT-4 — whole-shell composition guard for <UnifiedRoot>, THE app root.
 *
 * The three children have isolated regression tests (RebasedLsatRouter,
 * LsatUnifiedMount, SharedLayout), but nothing asserted the actual top-level
 * route split. If the splat regressed (e.g. path="/lsat" instead of "/lsat/*" —
 * the exact failure mode the inline comment warns about), every child test would
 * still pass while the real app blanked /lsat. This renders UnifiedRoot with both
 * planes stubbed and asserts the split + the one-time host startup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const runHostStartupOnce = vi.fn();
vi.mock('../lib/hostStartup', () => ({ runHostStartupOnce: () => runHostStartupOnce() }));
vi.mock('../App', () => ({ default: () => <div data-testid="host-shell">host</div> }));
vi.mock('./LsatUnifiedMount', () => ({ default: () => <div data-testid="lsat-mount">lsat</div> }));
// The cross-domain sync hooks fire fetches on mount; stub them to inert no-ops so
// this composition test exercises only the route split.
vi.mock('../hooks/useSyncProgress', () => ({ useSyncProgress: () => ({ sessionEnd: vi.fn() }) }));
vi.mock('../hooks/useSyncFsrsWriteBack', () => ({ useSyncFsrsWriteBack: () => ({ sessionEnd: vi.fn() }) }));

import UnifiedRoot from './UnifiedRoot';

beforeEach(() => {
  runHostStartupOnce.mockClear();
});
afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('UnifiedRoot route split', () => {
  it('mounts the LSAT plane for a deep /lsat/* URL', async () => {
    window.history.pushState({}, '', '/lsat/srs');
    render(<UnifiedRoot />);
    expect(await screen.findByTestId('lsat-mount')).toBeInTheDocument();
    expect(screen.queryByTestId('host-shell')).not.toBeInTheDocument();
  });

  it('mounts the LSAT plane for the bare /lsat URL (splat matches empty remainder)', async () => {
    window.history.pushState({}, '', '/lsat');
    render(<UnifiedRoot />);
    expect(await screen.findByTestId('lsat-mount')).toBeInTheDocument();
  });

  it('mounts the host shell for a non-LSAT URL', async () => {
    window.history.pushState({}, '', '/cfa/level1/fixed-income');
    render(<UnifiedRoot />);
    expect(await screen.findByTestId('host-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('lsat-mount')).not.toBeInTheDocument();
  });

  it('swaps the rendered plane on a cross-domain navigateDomain hop (audit H3)', async () => {
    window.history.pushState({}, '', '/');
    render(<UnifiedRoot />);
    expect(await screen.findByTestId('host-shell')).toBeInTheDocument();
    // navigateDomain() does pushState + dispatches DOMAIN_NAV_EVENT; the
    // CrossDomainNavBridge must re-sync the single router so the plane swaps
    // WITHOUT a reload (the bug: URL changed but the view stayed put).
    act(() => {
      window.history.pushState({}, '', '/lsat/srs');
      window.dispatchEvent(new Event('studyvault:navigate'));
    });
    expect(await screen.findByTestId('lsat-mount')).toBeInTheDocument();
    expect(screen.queryByTestId('host-shell')).not.toBeInTheDocument();
  });

  it('runs the one-time host startup exactly once', async () => {
    window.history.pushState({}, '', '/');
    render(<UnifiedRoot />);
    await screen.findByTestId('host-shell');
    expect(runHostStartupOnce).toHaveBeenCalledTimes(1);
  });
});
