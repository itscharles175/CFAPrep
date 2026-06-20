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
// Host CSS world — same imports host-entry.jsx makes for the legacy host branch,
// so the host shell paints identically under the unified root.
import '../index.css';
import '../styles/tokens.css';
import '../styles/unified-palette.css';
import 'katex/dist/katex.min.css';

const HostShell = lazy(() => import('../App'));
const LsatUnifiedMount = lazy(() => import('./LsatUnifiedMount'));

function RootFallback() {
  return <div style={{ minHeight: '100vh', background: 'var(--bg-primary, #080B10)' }} />;
}

export default function UnifiedRoot() {
  useEffect(() => {
    runHostStartupOnce();
  }, []);

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
