/*
 * K4-7 — <LsatUnifiedMount>: the flag-ON unified mount for the vendored LSAT
 * surface (Phase 1 of Keystone K4: full UI unification).
 *
 * DORMANT BY DEFAULT. Nothing renders this unless `LSAT_UNIFIED_SHELL` is ON.
 * With the flag OFF, src/main.jsx keeps its legacy split-shell behavior
 * byte-for-byte (LsatRoot under its own `<BrowserRouter basename="/lsat">`); this
 * file is never reached. See src/lib/featureFlags.ts + src/components/SharedLayout.tsx.
 *
 * WHAT THIS REPLACES (flag-ON only): the legacy `src/domains/lsat/LsatRoot.tsx`
 * mounted the LSAT plane as a SELF-CONTAINED sub-app — its OWN BrowserRouter, its
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

import { useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiValidationError } from '@lsat/lib/apiSchemas';
import { ThemeProvider as LsatThemeProvider } from '@lsat/components/theme-provider';
import { ModeProvider } from '@lsat/components/mode-provider';
import { MotionProvider } from '@lsat/components/motion-provider';
import { TooltipProvider } from '@lsat/components/ui/tooltip';
import LsatApp from '@lsat/App';
import { applyDensity, applyHighContrast, applyMeasureCh } from '@lsat/lib/prefs';
import { startAutoFlush } from '@lsat/lib/offlineQueue';
import { UnifiedShellContext } from '@lsat/lib/unifiedShellContext';
import { LSAT_ROUTE_PREFIX } from '../lib/lsatNavigate';
import SharedLayout from './SharedLayout';
import '@lsat/index.css';

/** K4-13a — the unified-shell signal value, hoisted to a module constant so the
 *  context Provider gets a STABLE reference (never a fresh object per render). */
const UNIFIED_SHELL_VALUE = { unified: true } as const;

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

/** Replicates react-router's internal `stripBasename` (not exported). Returns the
 *  path with `basename` removed, or null if `pathname` isn't under `basename`. */
function stripBasename(pathname: string, basename: string): string | null {
  if (basename === '/') return pathname;
  if (!pathname.toLowerCase().startsWith(basename.toLowerCase())) return null;
  const startIndex = basename.endsWith('/') ? basename.length - 1 : basename.length;
  const nextChar = pathname.charAt(startIndex);
  if (nextChar && nextChar !== '/') return null;
  return pathname.slice(startIndex) || '/';
}

/**
 * Re-base the host router on `/lsat` WITHOUT a second history.
 *
 * We canNOT use `<BrowserRouter>` OR the low-level `<Router>` here: BOTH assert
 * `invariant(!useInRouterContext())` and throw "You cannot render a <Router>
 * inside another <Router>" when nested under the host BrowserRouter. So we
 * replicate exactly what `<Router basename="/lsat">` does internally — provide a
 * fresh `NavigationContext` (carrying `basename="/lsat"` + the HOST navigator, i.e.
 * the one shared history) and a fresh `LocationContext` (carrying the host
 * location with `/lsat` STRIPPED) — but without the nesting guard.
 *
 * Effect: inside `<LsatApp/>`, `useLocation()` returns "/srs" (not "/lsat/srs"),
 * matching the legacy `BrowserRouter basename="/lsat"` contract its absolute
 * routes + `<Routes location={location}>` were authored for; and `useNavigate`
 * reads `basename` from this NavigationContext and re-prefixes "/srs" → "/lsat/srs"
 * onto the shared host history. The host App re-renders on every host navigation,
 * so this re-renders with the current location (live tracking, one history).
 */
export function RebasedLsatRouter({ children }: { children: ReactNode }) {
  const parentNav = useContext(UNSAFE_NavigationContext);
  const location = useLocation();
  const navigationType = useNavigationType();

  const navigationContextValue = useMemo(
    () => ({
      basename: LSAT_ROUTE_PREFIX,
      navigator: parentNav.navigator,
      static: parentNav.static,
      // `future: {}` mirrors what RR's own `<Router>` puts here; the declarative
      // hooks read basename/navigator/static, but we match the full shape so a
      // future RR minor that reads `.future` can't trip on undefined.
      future: {},
    }),
    [parentNav.navigator, parentNav.static],
  );

  const locationContextValue = useMemo(() => {
    const stripped = stripBasename(location.pathname, LSAT_ROUTE_PREFIX);
    return {
      location: {
        ...location,
        // Fall back to "/" if (defensively) the path isn't under /lsat — this
        // branch only ever renders for /lsat URLs, so `stripped` is non-null.
        pathname: stripped ?? '/',
      },
      navigationType,
    };
  }, [location, navigationType]);

  // `UNSAFE_*Context` are React contexts; provide both exactly as `<Router>` does.
  // Casts: their public types are intentionally opaque, so we assert the shapes
  // RR's own `<Router>` builds (verified against the installed source).
  const NavigationProvider = UNSAFE_NavigationContext.Provider as React.Provider<unknown>;
  const LocationProvider = UNSAFE_LocationContext.Provider as React.Provider<unknown>;
  return (
    <NavigationProvider value={navigationContextValue}>
      <LocationProvider value={locationContextValue}>{children}</LocationProvider>
    </NavigationProvider>
  );
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
                  App sees. K4-13a: the LSAT App now renders CHROMELESS inside this
                  (its AppShell drops its own Sidebar/header, GlobalChrome drops its
                  Titlebar) via the UnifiedShellContext below — so there is exactly
                  ONE sidebar/topbar/titlebar, supplied by SharedLayout. */}
              <SharedLayout>
                {/* K4-13a — signal the LSAT App that it is mounted INSIDE the
                    host SharedLayout so it renders CHROMELESS (no second
                    sidebar/topbar/titlebar). SharedLayout supplies the one set
                    of chrome; the LSAT App keeps its providers + scroll
                    restoration + page content. The default context value is
                    `{ unified: false }`, so the legacy LsatRoot path (which has
                    no provider) is unchanged. */}
                <UnifiedShellContext.Provider value={UNIFIED_SHELL_VALUE}>
                  <RebasedLsatRouter>
                    <LsatApp />
                  </RebasedLsatRouter>
                </UnifiedShellContext.Provider>
              </SharedLayout>
            </TooltipProvider>
          </MotionProvider>
        </ModeProvider>
      </LsatThemeProvider>
    </QueryClientProvider>
  );
}
