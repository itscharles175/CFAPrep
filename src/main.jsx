import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { applyTheme, getStoredTheme, migrateLegacyLsatTheme } from './lib/theme';

// K4-13 (final cutover): StudyVault now boots a SINGLE unified root. The host
// (CFA/Quant/Excel) and the vendored LSAT domain share ONE host <BrowserRouter>
// (see <UnifiedRoot>): `/lsat/*` mounts the LSAT plane via <LsatUnifiedMount>
// inside the host <SharedLayout>, everything else mounts the host <App/>. The
// legacy split-shell (a per-domain HostApp <-> LsatRoot swap with CSS isolation)
// and the `LSAT_UNIFIED_SHELL` flag have been removed — the unified shell is the
// only path. <UnifiedRoot> runs the one-time host startup (runHostStartupOnce).
const rootEl = document.getElementById('root');

// Lazy so the entry chunk stays small; the unified root pulls in the host shell
// and the LSAT plane on demand.
const UnifiedRoot = React.lazy(() => import('./components/UnifiedRoot.tsx'));

function RootFallback() {
  // Brief, themed blank while the unified root's chunk resolves.
  return <div style={{ minHeight: '100vh', background: 'var(--bg-primary, #080B10)' }} />;
}

// UA2: fold any legacy per-domain LSAT theme (`lsatlab-theme`) into the shared
// `qv-theme` store once, before we read it — so an upgrading user keeps their
// LSAT choice and the two keys can never drift again.
migrateLegacyLsatTheme();
// Apply the stored theme to <html> BEFORE React mounts so the first paint shows
// the correct palette (avoids a one-frame wrong-theme flash).
applyTheme(getStoredTheme());

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Suspense fallback={<RootFallback />}>
      <UnifiedRoot />
    </Suspense>
  </React.StrictMode>,
);
