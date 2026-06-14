import React, { lazy, Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { applyTheme, getStoredTheme } from './lib/theme';
import {
  DOMAIN_NAV_EVENT,
  domainForPath,
  setActiveDomain,
  startStyleIsolation,
} from './lib/domainNav';

// StudyVault is two large apps sharing one window + bundle: the CFA/Quant/Excel
// host and the vendored LSAT domain. Each keeps its OWN router + design system.
// Before S6 they lived in separate page loads (a hard window.location switch);
// now ONE React root swaps which sub-app is mounted, so crossing /cfa <-> /lsat
// is a soft navigation (no reload, no white flash, no bundle re-download).
//
// Only one sub-app is ever mounted, so the two BrowserRouters never coexist.
// Their stylesheets WOULD conflict in one document, so lib/domainNav keeps only
// the active domain's CSS live (see startStyleIsolation / setActiveDomain).
const rootEl = document.getElementById('root');

const HostApp = lazy(() => import('./host-entry.jsx'));
const LsatRoot = lazy(() => import('./domains/lsat/LsatRoot.tsx'));

// Theme bridge. The host (qv-theme -> data-theme attr) and the LSAT app
// (lsatlab-theme -> `dark` class) use the SAME vocabulary (light/dark/system).
// The host is the primary theme surface, so before showing the LSAT branch we
// copy the host's choice into the LSAT key BEFORE its ThemeProvider reads it.
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

function DomainFallback() {
  // Brief, themed blank while a domain's chunk resolves on first switch.
  return <div style={{ minHeight: '100vh', background: 'var(--bg-primary, #080B10)' }} />;
}

function StudyVaultRoot() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    // popstate = browser back/forward (incl. crossing the domain boundary);
    // DOMAIN_NAV_EVENT = our programmatic cross-domain hops.
    window.addEventListener('popstate', sync);
    window.addEventListener(DOMAIN_NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(DOMAIN_NAV_EVENT, sync);
    };
  }, []);

  const domain = domainForPath(pathname);

  // Keep only the active domain's CSS live, and bridge the theme before the LSAT
  // provider tree reads it. Done in render (not an effect) so the swap is
  // isolated BEFORE the new sub-app paints — both calls are idempotent.
  setActiveDomain(domain);
  if (domain === 'lsat') bridgeThemeToLsat();

  return (
    <Suspense fallback={<DomainFallback />}>
      {domain === 'lsat' ? <LsatRoot /> : <HostApp />}
    </Suspense>
  );
}

// Apply the stored theme to <html> BEFORE React mounts so the first paint shows
// the correct palette (avoids a one-frame wrong-theme flash).
applyTheme(getStoredTheme());
// Start attributing injected stylesheets to a domain before any sub-app's CSS
// loads, seeded with the domain of the initial URL.
startStyleIsolation(domainForPath(window.location.pathname));

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <StudyVaultRoot />
  </React.StrictMode>,
);
