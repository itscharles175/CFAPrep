// Host (CFA / Quant / Excel) entry. Loaded ONLY by the host branch in
// main.jsx — so its static CSS imports + bootstraps never load in the LSAT
// branch, keeping the two style/runtime worlds isolated while sharing one
// window + bundle. This is the original top-level entry logic, unchanged.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './styles/tokens.css';
// KaTeX CSS bundled locally from npm — the strict-offline invariant forbids
// the cdn.jsdelivr.net `katex.min.css` that used to be linked from index.html.
import 'katex/dist/katex.min.css';
import { registerServiceWorker } from './registerServiceWorker';
import { bootstrapSourceVault } from './lib/bootstrapSourceVault';
import { bootstrapAiContent } from './lib/bootstrapAiContent';
import { applyTheme, getStoredTheme } from './lib/theme';
import { bootstrapFsrsParameters } from './lib/bootstrapFsrsParameters';
import { bootstrapStorage } from './lib/bootstrapStorage';

export function mountHost(rootEl) {
  // Apply the stored theme to <html> BEFORE React mounts so the first paint
  // already shows the correct palette (avoids a one-frame wrong-theme flash).
  applyTheme(getStoredTheme());

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );

  registerServiceWorker();

  // Re-activate the user's chosen storage backend BEFORE the data bootstraps
  // run, so they read/write through the correct driver. Falls back to Dexie.
  bootstrapStorage().finally(() => {
    bootstrapSourceVault();
    bootstrapAiContent();
    bootstrapFsrsParameters();
  });
}
