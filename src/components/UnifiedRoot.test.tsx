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
import { act, render, screen, waitFor } from '@testing-library/react';
import type { StudyVaultBridge, StudyVaultNativeNavigationEvent } from '../lib/desktopBridge';
import type { StudyVaultLifecycleEvent } from '../lib/desktopBridge';
import { NATIVE_RECOVERY_EVENT } from '../lib/nativeShell';

const runHostStartupOnce = vi.fn();
vi.mock('../lib/hostStartup', () => ({ runHostStartupOnce: () => runHostStartupOnce() }));
vi.mock('../App', () => ({ default: () => <main id="main" tabIndex={-1} data-testid="host-shell">host</main> }));
vi.mock('./LsatUnifiedMount', () => ({ default: () => <main id="main" tabIndex={-1} data-testid="lsat-mount">lsat</main> }));
// The cross-domain sync hooks fire fetches on mount; stub them to inert no-ops so
// this composition test exercises only the route split.
vi.mock('../hooks/useSyncProgress', () => ({ useSyncProgress: () => ({ sessionEnd: vi.fn() }) }));
vi.mock('../hooks/useSyncFsrsWriteBack', () => ({ useSyncFsrsWriteBack: () => ({ sessionEnd: vi.fn() }) }));

import UnifiedRoot, { RootFallback, ROUTE_RECOVERY_DELAY_MS } from './UnifiedRoot';

beforeEach(() => {
  runHostStartupOnce.mockClear();
  delete window.studyvault;
});
afterEach(() => {
  window.history.pushState({}, '', '/');
  delete window.studyvault;
  delete document.documentElement.dataset.nativeShell;
});

describe('UnifiedRoot route split', () => {
  it('makes a delayed plane load recoverable without losing the StudyVault frame', () => {
    vi.useFakeTimers();
    render(<RootFallback />);
    expect(screen.getByRole('status', { name: 'Opening StudyVault' })).toBeInTheDocument();
    expect(screen.getByText('StudyVault')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload StudyVault' })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(ROUTE_RECOVERY_DELAY_MS));
    expect(screen.getByRole('button', { name: 'Reload StudyVault' })).toBeInTheDocument();
    vi.useRealTimers();
  });

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

  it('routes a validated native menu command through the single shell', async () => {
    let emitNativeNavigation: ((event: StudyVaultNativeNavigationEvent) => void) | undefined;
    window.studyvault = {
      events: {
        onNativeNavigate: (handler: (event: StudyVaultNativeNavigationEvent) => void) => {
          emitNativeNavigation = handler;
          return () => { emitNativeNavigation = undefined; };
        },
      },
    } as unknown as StudyVaultBridge;
    render(<UnifiedRoot />);
    expect(await screen.findByTestId('host-shell')).toBeInTheDocument();
    expect(document.documentElement.dataset.nativeShell).toBe('macos-unified');

    act(() => emitNativeNavigation?.({ route: '/lsat/review', source: 'menu' }));
    expect(await screen.findByTestId('lsat-mount')).toBeInTheDocument();
  });

  it('returns focus to the rendered main region after native navigation', async () => {
    let emitNativeNavigation: ((event: StudyVaultNativeNavigationEvent) => void) | undefined;
    window.studyvault = {
      events: {
        onNativeNavigate: (handler: (event: StudyVaultNativeNavigationEvent) => void) => {
          emitNativeNavigation = handler;
          return () => { emitNativeNavigation = undefined; };
        },
      },
    } as unknown as StudyVaultBridge;
    window.history.pushState({}, '', '/');
    render(<UnifiedRoot />);
    const main = await screen.findByTestId('host-shell');
    main.focus();
    expect(main).toHaveFocus();

    act(() => emitNativeNavigation?.({ route: '/', source: 'menu' }));
    await waitFor(() => expect(screen.getByTestId('host-shell')).toHaveFocus());
  });

  it('signals renderer recovery on native resume regardless of active plane', async () => {
    const lifecycleHandlers: Array<(event: StudyVaultLifecycleEvent) => void> = [];
    window.studyvault = {
      events: {
        onLifecycle: (handler: (event: StudyVaultLifecycleEvent) => void) => {
          lifecycleHandlers.push(handler);
          return () => {
            const index = lifecycleHandlers.indexOf(handler);
            if (index >= 0) lifecycleHandlers.splice(index, 1);
          };
        },
      },
    } as unknown as StudyVaultBridge;
    const recovery = vi.fn();
    window.addEventListener(NATIVE_RECOVERY_EVENT, recovery);
    window.history.pushState({}, '', '/lsat/srs');
    render(<UnifiedRoot />);
    await screen.findByTestId('lsat-mount');

    act(() => lifecycleHandlers.forEach((handler) => handler({ state: 'resume', at: 42_000 })));
    expect(recovery).toHaveBeenCalledTimes(1);
    window.removeEventListener(NATIVE_RECOVERY_EVENT, recovery);
  });
});
