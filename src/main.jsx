import React from 'react';
import ReactDOM from 'react-dom/client';

// StudyVault is two large apps sharing one window + bundle: the CFA/Quant/Excel
// host and the vendored LSAT domain. They never render simultaneously — we
// branch at the very top on the URL so only one BrowserRouter is ever live
// (the LSAT app brings its own, with basename="/lsat"). Domain switches are
// hard navigations (window.location), giving a clean state boundary. Each
// branch dynamically imports its own entry, so the host's CSS/bootstraps and
// the LSAT app's Tailwind/providers stay in separate chunks and never collide.
const rootEl = document.getElementById('root');
const isLsat =
  typeof window !== 'undefined' && window.location.pathname.startsWith('/lsat');

function showBootError(label, err) {
  console.error(`StudyVault: ${label} failed to load:`, err);
  if (rootEl) {
    rootEl.innerHTML =
      `<div style="padding:2rem;font-family:system-ui;line-height:1.5">` +
      `<strong>${label} failed to load.</strong><br/>See the console for details.</div>`;
  }
}

// Phase 4 — theme bridge. The host (qv-theme → data-theme attr) and the LSAT
// app (lsatlab-theme → `dark` class) use the SAME vocabulary (light/dark/system,
// system resolved via prefers-color-scheme). The host is the primary theme
// surface, so on entering the /lsat branch we copy the host's choice into the
// LSAT key BEFORE its ThemeProvider reads it — /lsat then matches the host's
// light/dark/system selection. (One-way by design: the host dashboard is where
// the umbrella theme is set; per-domain tweaks inside LSAT remain possible.)
function bridgeThemeToLsat() {
  try {
    const host = localStorage.getItem('qv-theme');
    if (host === 'light' || host === 'dark' || host === 'system') {
      localStorage.setItem('lsatlab-theme', host);
    }
  } catch {
    /* private-mode / quota — LSAT falls back to its own stored/default theme */
  }
}

if (isLsat) {
  bridgeThemeToLsat();
  import('./domains/lsat/LsatRoot.tsx')
    .then(({ default: LsatRoot }) => {
      ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
          <LsatRoot />
        </React.StrictMode>
      );
    })
    .catch((err) => showBootError('The LSAT module', err));
} else {
  import('./host-entry.jsx')
    .then(({ mountHost }) => mountHost(rootEl))
    .catch((err) => showBootError('StudyVault', err));
}
