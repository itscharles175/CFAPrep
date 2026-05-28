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

// Apply the stored theme to <html> BEFORE React mounts so the first paint
// already shows the correct palette. Without this, users with the light
// theme persisted would see a one-frame dark flash while React boots.
applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

registerServiceWorker();

// Load the ingested CFA curriculum into the local source vault on first run.
bootstrapSourceVault();

// Seed the AI-questions + AI-flashcards caches from `public/cfa-generated.json`
// if a pre-generated companion bundle is present (see scripts/content-expand.mjs).
bootstrapAiContent();
