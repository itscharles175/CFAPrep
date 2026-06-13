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

if (isLsat) {
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
