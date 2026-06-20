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

import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { runHostStartupOnce } from '../lib/hostStartup';
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

export default function UnifiedRoot() {
  useEffect(() => {
    runHostStartupOnce();
  }, []);

  // Cross-domain sync feed (AUDIT-1). Mounted once at the root so the host plane's
  // progress + FSRS scheduling are mirrored into the LSAT sidecar for the unified
  // ability/plan engine. Both are route-independent (Dexie-backed) and degrade to
  // a no-op when the sidecar is unreachable.
  useSyncProgress();
  useSyncFsrsWriteBack();

  return (
    <BrowserRouter>
      <Suspense fallback={<RootFallback />}>
        <Routes>
          {/* The LSAT plane: ONE splat route captures the bare /lsat AND every
              /lsat/* URL (the splat matches the empty remainder), handing it to
              the re-based LSAT router inside <LsatUnifiedMount>. The `/*` is
              required so the matched pathnameBase stays "/lsat" while descendant
              routing continues below it — a bare `path="/lsat"` would set an exact
              base with no splat and RR would refuse to render the LSAT App's
              descendant <Routes>. */}
          <Route path="/lsat/*" element={<LsatUnifiedMount />} />
          {/* Everything else is the host shell, which owns its own <Routes>. */}
          <Route path="/*" element={<HostShell />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
