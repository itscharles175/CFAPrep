import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { applyTheme, getStoredTheme, migrateLegacyLsatTheme } from './lib/theme';
import ErrorBoundary from './components/ErrorBoundary';

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

// Self-contained boot styles. The app's index.css is imported INSIDE the
// UnifiedRoot chunk, so neither the loading nor the crash screen below can rely
// on app classes/tokens (they render BEFORE that chunk resolves, and must still
// render if it FAILS to load). Everything here is inline + a one-off <style>.
const BOOT_BG = 'var(--bg-primary, #080B10)';
const BOOT_FG = 'var(--text-primary, #F1F5F9)';
const BOOT_ACCENT = 'var(--accent-strong, #2563EB)';

function RootFallback() {
  // Branded first-paint / chunk-compile placeholder — a calm centered spinner so
  // a slow load reads as "loading", never as a blank/broken screen. The previous
  // bare coloured <div> looked identical to a crash during a long dev compile.
  return (
    <div
      role="status"
      aria-label="Loading StudyVault"
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: BOOT_BG }}
    >
      <style>{'@keyframes qv-boot-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.qv-boot-ring{animation:none!important}}'}</style>
      <span
        className="qv-boot-ring"
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          border: '3px solid rgba(148,163,184,0.25)',
          borderTopColor: BOOT_ACCENT,
          animation: 'qv-boot-spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

function RootCrashFallback({ error, reset }) {
  // Top-level safety net: if the UnifiedRoot chunk FAILS to load (a stale chunk
  // hash after a deploy, an offline fetch, a corrupt cache) or any provider/root
  // render throws above the in-app boundaries, show a recovery screen instead of
  // a blank page. A hard reload re-fetches chunks (a soft reset would just retry
  // the same failed import), so that's the primary action.
  const isChunkError = /chunk|dynamically imported|importing a module|Failed to fetch/i.test(
    error?.message || '',
  );
  return (
    <div
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: BOOT_BG,
        color: BOOT_FG,
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>
          StudyVault couldn&rsquo;t finish loading
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.8, margin: '0 0 20px' }}>
          {isChunkError
            ? 'A part of the app failed to load — this usually clears after a reload (often a cached file from a previous version).'
            : 'Something went wrong while starting the app. Reloading usually fixes it; your local data is untouched.'}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: 0,
              background: BOOT_ACCENT,
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(148,163,184,0.4)',
              background: 'transparent',
              color: BOOT_FG,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
        {error?.message ? (
          <pre
            style={{
              marginTop: 16,
              padding: 8,
              maxHeight: 96,
              overflow: 'auto',
              fontSize: 11,
              textAlign: 'left',
              opacity: 0.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
          </pre>
        ) : null}
      </div>
    </div>
  );
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
    {/* Top-level safety net. The boundary wraps the Suspense (NOT the reverse) so
        it also catches a rejected lazy import of the UnifiedRoot chunk — the
        classic "white screen after deploy" / chunk-load failure — not just render
        crashes. In-app route boundaries still handle per-route errors first. */}
    <ErrorBoundary name="root" level="page" fallback={RootCrashFallback}>
      <Suspense fallback={<RootFallback />}>
        <UnifiedRoot />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
