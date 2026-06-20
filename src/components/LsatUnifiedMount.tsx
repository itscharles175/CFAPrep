/*
 * K4-7 — <LsatUnifiedMount>: the unified mount for the vendored LSAT surface
 * (Keystone K4: full UI unification).
 *
 * This is THE LSAT mount as of the K4-13 cutover: <UnifiedRoot> routes `/lsat/*`
 * here, mounting the LSAT plane inside the host <SharedLayout> (one host router,
 * one set of chrome). See src/components/UnifiedRoot.tsx + SharedLayout.tsx.
 *
 * WHAT THIS REPLACED: the removed `src/domains/lsat/LsatRoot.tsx` mounted the
 * LSAT plane as a SELF-CONTAINED sub-app — its OWN BrowserRouter, its
 * OWN provider stack, and its OWN startup side-effects — that the host swapped in
 * (and OUT, unmounting it) on a cross-domain hop. Under the unified shell the LSAT
 * routes live INSIDE the host's single `<BrowserRouter>` and are persistently
 * mounted, so:
 *
 *   1. ROUTER UNIFY (no second history). We do NOT nest a second `BrowserRouter`
 *      (RR v7 throws "You cannot render a <Router> inside another <Router>"). We
 *      mount the UNMODIFIED LSAT `<App/>` inside a low-level `<Router>` that
 *      RE-USES the host navigator (the one shared `window.history`) and re-bases
 *      it on `/lsat` via `basename`. The LSAT App reads `useLocation()` (which the
 *      re-basing `<Router>` strips to "/srs" from the browser's "/lsat/srs") and
 *      feeds it to its own `<Routes location=...>` with absolute paths — exactly
 *      as it did under the old `BrowserRouter basename="/lsat"`, so its routes,
 *      `<AnimatePresence>` page transitions, and full-bleed exam branch all work
 *      unchanged. `useLsatNavigate`/`toLsatPath` (K4-5) and the LSAT App's own
 *      `useNavigate("/srs")` resolve to `/lsat/srs` through this same `basename`.
 *
 *   2. PROVIDER CONSOLIDATION (mounted ONCE). The LSAT providers
 *      (QueryClientProvider, the LSAT ThemeProvider, ModeProvider, MotionProvider,
 *      TooltipProvider) live here, ABOVE the persistently-mounted routes, instead
 *      of inside LsatRoot. The QueryClient is created once per mount (a ref) and
 *      the LSAT startup side-effects run from a single effect WITH TEARDOWN (see
 *      the effect below) — critical now that the mount is persistent and is not
 *      unmounted on a domain switch.
 *
 *   3. THEME COLLAPSE (one source of truth). The base light/dark/system theme has
 *      ONE owner — the shared `qv-theme` store (src/lib/theme.ts, UA2). The host
 *      `ThemeProvider` (src/context/ThemeContext) wraps the whole host App and
 *      owns `<html data-theme>`; the LSAT `ThemeProvider` here is a thin adapter
 *      over the SAME store that additionally supplies the LSAT-only `useTheme()`
 *      context its components import, plus density / high-contrast. Both read and
 *      write the one store, so they cannot drift — there is a single theme source
 *      of truth even though two context adapters expose it to their own subtrees.
 */

import { useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiValidationError } from '@lsat/lib/apiSchemas';
import { ThemeProvider as LsatThemeProvider } from '@lsat/components/theme-provider';
import { ModeProvider } from '@lsat/components/mode-provider';
import { MotionProvider } from '@lsat/components/motion-provider';
import { TooltipProvider } from '@lsat/components/ui/tooltip';
import LsatApp from '@lsat/App';
import { applyDensity, applyHighContrast, applyMeasureCh } from '@lsat/lib/prefs';
import { startAutoFlush } from '@lsat/lib/offlineQueue';
// K4-7 — the host-router re-basing primitive lives in its own module so it can be
// unit-tested without pulling in the heavy LSAT app graph (see RebasedLsatRouter.tsx).
import { RebasedLsatRouter } from './RebasedLsatRouter';
import SharedLayout from './SharedLayout';
import '@lsat/index.css';

/** Mirrors `LsatRoot.makeQueryClient` exactly so the unified path's data-layer
 *  behavior (retry/refetch/throwOnError policy) matches the legacy path. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          !(error instanceof ApiValidationError) && failureCount < 1,
        refetchOnWindowFocus: false,
        throwOnError: (error) => error instanceof ApiValidationError,
      },
    },
  });
}

/**
 * The consolidated LSAT provider stack + startup side-effects, mounted ONCE for
 * the lifetime of the unified shell. Mirrors LsatRoot's tree, minus the
 * BrowserRouter (the host owns the one router) and the host-owned StrictMode/root.
 */
export default function LsatUnifiedMount() {
  // One client for the lifetime of this mount (parity with LsatRoot).
  const clientRef = useRef<QueryClient | null>(null);
  if (clientRef.current === null) clientRef.current = makeQueryClient();

  useEffect(() => {
    // ── LsatRoot startup side-effects, preserved verbatim (run once on mount) ──
    // These previously ran inside LsatRoot's effect; the unified mount is now the
    // single owner. Because this mount is PERSISTENT (it is not unmounted on a
    // domain switch the way LsatRoot was), every listener/timer below returns a
    // cleanup so nothing leaks for the app lifetime.

    // 1-3. Idempotent <html> stamps from persisted prefs (no listeners/timers).
    applyDensity();
    applyHighContrast();
    applyMeasureCh();

    // 4. Windows 11 Mica/vibrancy opt-in, Tauri-gated + best-effort. Fire-and-
    //    forget dynamic import; guarded so a late resolve after unmount is inert.
    let disposed = false;
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke<boolean>('mica_active'))
        .then((on) => {
          if (!disposed && on) document.documentElement.classList.add('mica');
        })
        .catch(() => {});
    }

    // 5. Pause the hero aurora's infinite animation while the window is hidden.
    //    PERSISTENT-MOUNT TEARDOWN: the visibilitychange listener is removed on
    //    unmount (returned below), unlike before where domain-swap unmount did it.
    const syncIdle = () =>
      document.documentElement.classList.toggle('is-idle', document.hidden);
    document.addEventListener('visibilitychange', syncIdle);
    syncIdle();

    // 6. Drain queued offline writes on reconnect + a slow periodic tick.
    //    PERSISTENT-MOUNT TEARDOWN: startAutoFlush is internally idempotent AND
    //    returns a disposer that removes the `online` listener and clears the
    //    periodic interval — we call it on unmount so the timer can't outlive us.
    const stopAutoFlush = startAutoFlush();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', syncIdle);
      stopAutoFlush();
    };
  }, []);

  return (
    <QueryClientProvider client={clientRef.current}>
      <LsatThemeProvider>
        <ModeProvider>
          <MotionProvider>
            <TooltipProvider delayDuration={200}>
              {/* SharedLayout (K4-6) is the unified host chrome. It MUST sit in
                  the HOST router context (above RebasedLsatRouter) so its Sidebar /
                  TopBar / breadcrumb / `data-domain` accent read the FULL host
                  pathname ("/lsat/srs"), not the basename-stripped "/srs" the LSAT
                  App sees. The LSAT App renders CHROMELESS (its AppShell is the
                  bare MainScrollArea + Outlet, GlobalChrome no longer renders a
                  Titlebar) — so SharedLayout supplies the one sidebar/topbar. */}
              <SharedLayout>
                <RebasedLsatRouter>
                  <LsatApp />
                </RebasedLsatRouter>
              </SharedLayout>
            </TooltipProvider>
          </MotionProvider>
        </ModeProvider>
      </LsatThemeProvider>
    </QueryClientProvider>
  );
}
