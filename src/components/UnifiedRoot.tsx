/*
 * K4-7 — <UnifiedRoot>: the application root (Keystone K4: full UI unification).
 *
 * THE ONLY ROOT as of the K4-13 cutover. src/main.jsx renders this directly; the
 * legacy `StudyVaultRoot` split-shell (HostApp vs LsatRoot swap) and the
 * `LSAT_UNIFIED_SHELL` flag have been removed.
 *
 * Instead of TWO sub-apps each owning their own `<BrowserRouter>` and being
 * swapped in/out on a cross-domain hop, there is ONE host `<BrowserRouter>` that
 * routes BOTH planes. A top-level `<Routes>` selects:
 *
 *   - `/lsat` + `/lsat/*`  -> <LsatUnifiedMount/>  (LSAT providers + startup +
 *                              the LSAT App re-based on /lsat inside SharedLayout)
 *   - everything else      -> the host <App/>      (unchanged host shell + routes)
 *
 * Both planes share the one history (no second router, no domain-swap unmount),
 * so the LSAT mount is PERSISTENT — its provider/effect teardown lives in
 * <LsatUnifiedMount> precisely because of that. The host CSS + one-time host
 * startup that host-entry.jsx owns for the legacy path are reproduced here (via
 * the shared `runHostStartupOnce`) since the legacy HostApp is not mounted on
 * this path.
 *
 * NOTE: there is no style-isolation observer here — under the unified shell both
 * design systems coexist in one document (the K4 reskin reconciles them), and the
 * legacy `startStyleIsolation` helper was removed in the K4-13 cutover.
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { runHostStartupOnce } from '../lib/hostStartup';
import ErrorBoundary from './ErrorBoundary';
import { DOMAIN_NAV_EVENT } from '../lib/domainNav';
import { fetchDataSchemaAlignment } from '../lib/dataDictionary';
// AUDIT-1 — activate the cross-domain feed. These two host→backend sync hooks
// (DATA-4a read-only progress feed + DATA-4b FSRS write-back) were fully built +
// backend-tested but never mounted, so the LSAT sidecar's HostProgressSnapshot
// mirror stayed empty and every cross-domain read (weakness-index host plane,
// study/today?include_host, leeches, blind-review-gap) returned LSAT-only data.
// Mounting them here — the one always-mounted root — turns the feed on: a push on
// mount + a ~5-min catch-up interval, fully degrading (a down sidecar is a silent
// no-op, never throws). The hooks own no React state, so they cause no re-renders.
import { useSyncProgress } from '../hooks/useSyncProgress';
import { useSyncFsrsWriteBack } from '../hooks/useSyncFsrsWriteBack';
// Host CSS world — same imports host-entry.jsx makes for the legacy host branch,
// so the host shell paints identically under the unified root.
import '../index.css';
import '../styles/tokens.css';
import '../styles/unified-palette.css';
import 'katex/dist/katex.min.css';

const HostShell = lazy(() => import('../App'));
const LsatUnifiedMount = lazy(() => import('./LsatUnifiedMount'));

function RootFallback() {
  // A calm centered spinner (not a bare blank div) so the on-demand load of the
  // host shell or the LSAT plane reads as "loading", never as a blank/broken
  // screen — the symptom reported on first navigation into /lsat/* before that
  // chunk has compiled. Self-contained inline + one-off keyframe so it renders
  // identically whether or not app CSS has finished loading.
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-primary, #080B10)' }}
    >
      <style>{'@keyframes qv-route-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.qv-route-ring{animation:none!important}}'}</style>
      <span
        className="qv-route-ring"
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '3px solid rgba(148,163,184,0.25)',
          borderTopColor: 'var(--accent-strong, #2563EB)',
          animation: 'qv-route-spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

// audit H3 — bridge cross-domain navigation INTO the single router.
// navigateDomain() does window.history.pushState + dispatches DOMAIN_NAV_EVENT,
// but a raw pushState is invisible to React-Router (it only observes native
// popstate), so cross-domain hops (Dashboard LSAT card, ⌘K jump, NotificationCenter
// rows, cross-domain Back) changed the URL while the mounted plane stayed put
// until a reload. This listener re-syncs RR to the just-pushed location with
// { replace: true } so the pushState entry isn't duplicated — RR re-renders the
// correct plane immediately and stays the authority for history state.
function CrossDomainNavBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = () => {
      navigate(window.location.pathname + window.location.search + window.location.hash, { replace: true });
    };
    window.addEventListener(DOMAIN_NAV_EVENT, handler);
    return () => window.removeEventListener(DOMAIN_NAV_EVENT, handler);
  }, [navigate]);
  return null;
}

// audit H4 — per-plane crash isolation. The host App and the LSAT App each wrap
// their inner routed content in a boundary, but the SHARED layers between the
// root and those inner boundaries (SharedLayout chrome, the LSAT provider stack,
// RebasedLsatRouter) had none — a throw there escaped to the root main.jsx
// boundary and white-screened the whole app. Wrapping each plane here resets the
// crash on route change so a transient render error in one plane's chrome can't
// take down the other plane or force a hard reload.
function PlaneBoundary({ name, children }: { name: string; children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary name={name} level="page" resetKey={pathname}>
      {children}
    </ErrorBoundary>
  );
}

export default function UnifiedRoot() {
  useEffect(() => {
    runHostStartupOnce();
  }, []);

  // Cross-domain sync feed (AUDIT-1). Mounted once at the root so the host plane's
  // progress + FSRS scheduling are mirrored into the LSAT sidecar for the unified
  // ability/plan engine. Both are route-independent (Dexie-backed) and degrade to
  // a no-op when the sidecar is unreachable.
  //
  // audit M3 — gate the WRITE path on the DATA-3 schema-version handshake. The
  // data dictionary's contract is that cross-domain writes are suppressed when
  // host and backend speak incompatible cross-domain schema versions (a shared
  // field's MEANING changed), but `crossDomainWritesEnabled` was only read for
  // display in System Health — the push fired regardless, so a version-mismatched
  // host kept corrupting the backend mirror the unified engine reads. Start
  // DISABLED, enable only once the handshake confirms alignment, and re-check on
  // an interval so a late sidecar start (or an upgrade) flips it on/off correctly.
  const [crossDomainWritesEnabled, setCrossDomainWritesEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    const check = () =>
      fetchDataSchemaAlignment()
        .then((alignment) => {
          if (active) setCrossDomainWritesEnabled(alignment.crossDomainWritesEnabled);
        })
        .catch(() => {
          if (active) setCrossDomainWritesEnabled(false);
        });
    void check();
    const id = setInterval(check, 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);
  useSyncProgress({ enabled: crossDomainWritesEnabled });
  useSyncFsrsWriteBack({ enabled: crossDomainWritesEnabled });

  return (
    <BrowserRouter>
      <CrossDomainNavBridge />
      <Suspense fallback={<RootFallback />}>
        <Routes>
          {/* The LSAT plane: ONE splat route captures the bare /lsat AND every
              /lsat/* URL (the splat matches the empty remainder), handing it to
              the re-based LSAT router inside <LsatUnifiedMount>. The `/*` is
              required so the matched pathnameBase stays "/lsat" while descendant
              routing continues below it — a bare `path="/lsat"` would set an exact
              base with no splat and RR would refuse to render the LSAT App's
              descendant <Routes>. */}
          <Route path="/lsat/*" element={<PlaneBoundary name="lsat-plane"><LsatUnifiedMount /></PlaneBoundary>} />
          {/* Everything else is the host shell, which owns its own <Routes>. */}
          <Route path="/*" element={<PlaneBoundary name="host-plane"><HostShell /></PlaneBoundary>} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
