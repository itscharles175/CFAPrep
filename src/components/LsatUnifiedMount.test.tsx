import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

/*
 * K4-7 — proves the unified LSAT mount's PERSISTENT-MOUNT teardown. Because the
 * unified shell no longer unmounts the LSAT plane on a domain switch, every
 * listener/timer the LSAT startup effect installs MUST be torn down on unmount or
 * it leaks for the app lifetime. This test mounts <LsatUnifiedMount> with the
 * heavy LSAT subtree stubbed (so the test stays fast + deterministic under the
 * host project), then unmounts and asserts:
 *   - the `visibilitychange` listener is removed, and
 *   - the disposer returned by startAutoFlush() is called.
 */

// Heavy LSAT children stubbed to trivial passthroughs — we are testing the mount
// shell's effect lifecycle, not the LSAT app itself.
vi.mock('@lsat/App', () => ({ default: () => <div data-testid="lsat-app" /> }));
vi.mock('@lsat/components/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@lsat/components/mode-provider', () => ({
  ModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@lsat/components/motion-provider', () => ({
  MotionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@lsat/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./SharedLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@lsat/lib/apiSchemas', () => ({ ApiValidationError: class ApiValidationError extends Error {} }));

// Spy targets: the prefs stamps (no listeners) + the auto-flush disposer.
const stopAutoFlush = vi.fn();
const startAutoFlush = vi.fn(() => stopAutoFlush);
const applyDensity = vi.fn();
const applyHighContrast = vi.fn();
const applyMeasureCh = vi.fn();
vi.mock('@lsat/lib/prefs', () => ({
  applyDensity: () => applyDensity(),
  applyHighContrast: () => applyHighContrast(),
  applyMeasureCh: () => applyMeasureCh(),
}));
vi.mock('@lsat/lib/offlineQueue', () => ({
  startAutoFlush: () => startAutoFlush(),
}));

import LsatUnifiedMount from './LsatUnifiedMount';
// RebasedLsatRouter moved to its own module in the K4 unified-shell fix; import it
// from there. (See RebasedLsatRouter.test.tsx for the nested-route regression guard.)
import { RebasedLsatRouter } from './RebasedLsatRouter';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LsatUnifiedMount teardown (K4-7)', () => {
  it('runs the LSAT startup stamps once and installs + tears down the listeners/timers', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount, getByTestId } = render(
      <MemoryRouter initialEntries={['/lsat/srs']}>
        <LsatUnifiedMount />
      </MemoryRouter>,
    );

    // Providers + re-based router resolved and the (stubbed) LSAT App rendered.
    expect(getByTestId('lsat-app')).toBeInTheDocument();

    // Startup stamps applied once.
    expect(applyDensity).toHaveBeenCalledTimes(1);
    expect(applyHighContrast).toHaveBeenCalledTimes(1);
    expect(applyMeasureCh).toHaveBeenCalledTimes(1);

    // The visibilitychange listener was installed and the auto-flush started.
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(startAutoFlush).toHaveBeenCalledTimes(1);
    expect(stopAutoFlush).not.toHaveBeenCalled();

    unmount();

    // TEARDOWN: listener removed (same handler reference) + disposer called.
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    const added = addSpy.mock.calls.find((c) => c[0] === 'visibilitychange');
    const removed = removeSpy.mock.calls.find((c) => c[0] === 'visibilitychange');
    expect(removed?.[1]).toBe(added?.[1]);
    expect(stopAutoFlush).toHaveBeenCalledTimes(1);
  });
});

describe('RebasedLsatRouter routing contract (K4-7)', () => {
  // A child that reads the (re-based) location and re-prefixes a relative nav.
  function Probe() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <div>
        <span data-testid="lsat-pathname">{location.pathname}</span>
        <Routes>
          {/* Absolute LSAT-style paths resolve against the /lsat-stripped path. */}
          <Route path="/srs" element={<span data-testid="matched">srs page</span>} />
          <Route path="*" element={<span data-testid="matched">no match</span>} />
        </Routes>
        <button type="button" onClick={() => navigate('/review')}>
          go review
        </button>
      </div>
    );
  }

  it('strips /lsat from the location the LSAT subtree sees and matches absolute routes', () => {
    render(
      <MemoryRouter initialEntries={['/lsat/srs']}>
        <RebasedLsatRouter>
          <Probe />
        </RebasedLsatRouter>
      </MemoryRouter>,
    );
    // Inside the re-based context useLocation() returns the /lsat-stripped path…
    expect(screen.getByTestId('lsat-pathname')).toHaveTextContent('/srs');
    // …so the LSAT App's absolute <Route path="/srs"> matches.
    expect(screen.getByTestId('matched')).toHaveTextContent('srs page');
  });

  it('re-prefixes a relative LSAT navigate("/review") to /lsat/review on the shared history', async () => {
    let observed = '';
    function HostObserver() {
      observed = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/lsat/srs']}>
        <HostObserver />
        <RebasedLsatRouter>
          <Probe />
        </RebasedLsatRouter>
      </MemoryRouter>,
    );
    expect(observed).toBe('/lsat/srs');
    await act(async () => {
      screen.getByRole('button', { name: 'go review' }).click();
    });
    // The host (outer) router observed the /lsat-prefixed destination — proving
    // the nested context navigates the ONE shared history with the basename.
    expect(observed).toBe('/lsat/review');
  });
});
