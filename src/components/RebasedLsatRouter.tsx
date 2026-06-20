/*
 * K4-7 — <RebasedLsatRouter>: re-base the host router on `/lsat` WITHOUT a second
 * history (Keystone K4: full UI unification).
 *
 * Extracted from <LsatUnifiedMount> so this RR-internals-hacking primitive — the
 * trickiest part of the unified shell — is isolated and unit-testable on its own
 * (it depends only on react + react-router-dom, not the heavy LSAT app graph).
 * <LsatUnifiedMount> composes it; see src/components/LsatUnifiedMount.tsx.
 */

import { useContext, useMemo, type ReactNode } from 'react';
import {
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import { LSAT_ROUTE_PREFIX } from '../lib/lsatNavigate';

/** Replicates react-router's internal `stripBasename` (not exported). Returns the
 *  path with `basename` removed, or null if `pathname` isn't under `basename`. */
export function stripBasename(pathname: string, basename: string): string | null {
  if (basename === '/') return pathname;
  if (!pathname.toLowerCase().startsWith(basename.toLowerCase())) return null;
  const startIndex = basename.endsWith('/') ? basename.length - 1 : basename.length;
  const nextChar = pathname.charAt(startIndex);
  if (nextChar && nextChar !== '/') return null;
  return pathname.slice(startIndex) || '/';
}

/** RR's default RouteContext value (no parent matches, base "/"). Provided by
 *  RebasedLsatRouter to reset the parent-route lineage so the LSAT App's inner
 *  `<Routes location>` is treated as a top-level router. Mirrors the shape RR's
 *  own `RouteContext` is created with: `{ outlet, matches, isDataRoute }`. */
export const EMPTY_ROUTE_CONTEXT = { outlet: null, matches: [], isDataRoute: false };

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

  // `UNSAFE_*Context` are React contexts; provide all three exactly as a top-level
  // `<Router>` + `<Routes>` would. Casts: their public types are intentionally
  // opaque, so we assert the shapes RR's own internals build (verified against the
  // installed source).
  const NavigationProvider = UNSAFE_NavigationContext.Provider as React.Provider<unknown>;
  const LocationProvider = UNSAFE_LocationContext.Provider as React.Provider<unknown>;
  // RR also threads a RouteContext carrying the PARENT route matches. Because
  // <LsatUnifiedMount> is rendered as the `element` of UnifiedRoot's
  // <Route path="/lsat/*">, that context's matched pathname base is "/lsat". The
  // LSAT App then renders <Routes location={…}> with the basename-stripped "/srs"
  // / "/" location, and RR asserts an override location must BEGIN WITH the parent
  // base ("/lsat") — so the stripped path throws ("pathname base is '/lsat' but
  // pathname '/' was given"). Resetting RouteContext to the empty root (no parent
  // matches, base "/") makes the LSAT App's inner <Routes> behave as a top-level
  // router again — exactly its contract under the old standalone <BrowserRouter>.
  const RouteProvider = UNSAFE_RouteContext.Provider as React.Provider<unknown>;
  return (
    <NavigationProvider value={navigationContextValue}>
      <LocationProvider value={locationContextValue}>
        <RouteProvider value={EMPTY_ROUTE_CONTEXT}>{children}</RouteProvider>
      </LocationProvider>
    </NavigationProvider>
  );
}
