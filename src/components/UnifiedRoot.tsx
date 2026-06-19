/*
 * K4-7 — <UnifiedRoot>: the flag-ON application root (Phase 1 of Keystone K4:
 * full UI unification).
 *
 * DORMANT BY DEFAULT. src/main.jsx renders this ONLY when `LSAT_UNIFIED_SHELL` is
 * ON. With the flag OFF (default) main.jsx keeps its legacy `StudyVaultRoot`
 * split-shell (HostApp vs LsatRoot swap) byte-for-byte — this file is unreached.
 *
 * What changes when the flag is ON: instead of TWO sub-apps each owning their own
 * `<BrowserRouter>` and being swapped in/out on a cross-domain hop, there is ONE
 * host `<BrowserRouter>` that routes BOTH planes. A top-level `<Routes>` selects:
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
 * NOTE: the style-isolation observer (lib/domainNav) that the legacy path uses to
 * disable the inactive domain's CSS is INTENTIONALLY not driven here — under the
 * unified shell both design systems are meant to coexist in one document (the K4
 * reskin reconciles them). This is flag-ON-only and verified by a later
 * supervised pass; flag-OFF behavior is unaffected.
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
          {/* The LSAT plane: its splat captures every /lsat/* URL and hands it to
              the re-based LSAT router inside <LsatUnifiedMount>. The bare /lsat
              entry is matched by the same element (its inner Router maps "/" to
              "/lsat"). */}
          <Route path="/lsat" element={<LsatUnifiedMount />} />
          <Route path="/lsat/*" element={<LsatUnifiedMount />} />
          {/* Everything else is the host shell, which owns its own <Routes>. */}
          <Route path="/*" element={<HostShell />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
