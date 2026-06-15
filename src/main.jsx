import React, { lazy, Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { applyTheme, getStoredTheme, migrateLegacyLsatTheme } from './lib/theme';
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
    //
    // Cross-domain back/forward correctness: on a popstate that crosses the
    // boundary, BOTH this listener (setPathname) and the mounted sub-app's
    // BrowserRouter (its own internal setState) fire synchronously in the same
    // event tick. React 18 automatic batching flushes them in ONE commit, in
    // which `domain` flips and the old sub-app unmounts — so the inactive
    // router never commits a wrong-domain (404) render. Do NOT introduce an
    // async boundary (await/setTimeout) in this handler, which would split the
    // updates into two commits and surface a one-frame flash of the old domain.
    window.addEventListener('popstate', sync);
    window.addEventListener(DOMAIN_NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(DOMAIN_NAV_EVENT, sync);
    };
  }, []);

  const domain = domainForPath(pathname);

  // Keep only the active domain's CSS live. Done in render (not an effect) so the
  // swap is isolated BEFORE the new sub-app paints — idempotent. UA2: there is no
  // longer a theme bridge here; both domains read the one shared `qv-theme` store
  // (src/lib/theme.ts), so the LSAT provider already sees the host's choice.
  setActiveDomain(domain);

  return (
    <Suspense fallback={<DomainFallback />}>
      {domain === 'lsat' ? <LsatRoot /> : <HostApp />}
    </Suspense>
  );
}

// UA2: fold any legacy per-domain LSAT theme (`lsatlab-theme`) into the shared
// `qv-theme` store once, before we read it — so an upgrading user keeps their
// LSAT choice and the two keys can never drift again.
migrateLegacyLsatTheme();
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
