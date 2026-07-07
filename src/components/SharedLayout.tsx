/*
 * K4-6 — <SharedLayout>: the unified host shell (Keystone K4: full UI
 * unification).
 *
 * As of the K4-13 cutover this is the LSAT plane's chrome: <LsatUnifiedMount>
 * wraps the LSAT App in it (host Sidebar + TopBar) inside the one host router.
 * It does NOT own the router; it renders its `children` (or a routed <Outlet/>)
 * inside the host chrome.
 *
 * Composition (host-styled, reusing the existing host shell pieces):
 *   - the host <Sidebar> with its 4th, LSAT-aware section (built from K4-5's
 *     `lsatAppRoutes`, grouped by navGroup, Test-Mode-aware via `lsatMode`),
 *   - the host <TopBar> with the shared breadcrumb/back/domain badge AND the
 *     LSAT study/test mode toggle wired to this layout's own mode state,
 *   - a host <main> content region that renders the children/outlet.
 *
 * SharedLayout owns the LSAT study/test mode here (Phase 1) the way the legacy
 * AppShell did — the unified router (K4-7) will later lift this to the merged
 * mode source. Both the Sidebar section and the TopBar toggle read it, so Test
 * Mode hides the LSAT `hideInTest` rows consistently.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Layout/Sidebar';
import TopBar, { type LsatShellMode } from './Layout/TopBar';
import { ThemeProvider } from '../context/ThemeContext';
import { ToastProvider } from '../context/ToastContext';
import { OfflineProvider } from '../context/OfflineContext';

interface SharedLayoutProps {
  /** Optional content. When omitted, a routed <Outlet/> is rendered (so this can
   *  be used as a react-router layout route once K4-7 wires the router). */
  children?: ReactNode;
}

function focusFirstVisibleSidebarTarget() {
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>('#main-sidebar a[href], #main-sidebar button:not([disabled])'),
  );
  const visibleTarget = targets.find((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  });
  const target = visibleTarget ?? targets[0];
  try {
    target?.focus?.({ preventScroll: true });
  } catch {
    target?.focus?.();
  }
}

export default function SharedLayout({ children }: SharedLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const mobileNavWasOpen = useRef(false);
  // K4-6: the unified shell owns LSAT study/test mode (legacy AppShell parity).
  // Both the Sidebar's LSAT section and the TopBar mode toggle read/write it.
  const [lsatMode, setLsatMode] = useState<LsatShellMode>('study');
  const location = useLocation();
  const mobileNavHidden = mobileViewport && !mobileNavOpen;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setMobileViewport(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    if (!mobileNavOpen) {
      if (mobileNavWasOpen.current) {
        (document.querySelector('.mobile-menu-button') as HTMLElement | null)?.focus?.();
      }
      mobileNavWasOpen.current = false;
      return undefined;
    }

    mobileNavWasOpen.current = true;
    const focusTimer = window.setTimeout(() => {
      focusFirstVisibleSidebarTarget();
    }, 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileNavOpen(false);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileNavOpen]);

  // Per-domain accent: mirror App.jsx — drive a `data-domain` body attribute from
  // the URL so tokens.css re-tints chips/buttons. The unified shell adds `lsat`.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const path = location.pathname;
    let domain = '';
    if (path === '/lsat' || path.startsWith('/lsat/')) domain = 'lsat';
    else if (path.startsWith('/cfa')) domain = 'cfa';
    else if (path.startsWith('/excel')) domain = 'excel';
    else if (path.startsWith('/quant')) domain = 'quant';
    if (domain) document.body.setAttribute('data-domain', domain);
    else document.body.removeAttribute('data-domain');
    return undefined;
  }, [location.pathname]);

  // K4 cutover fix: SharedLayout is the LSAT plane's host chrome, and the host
  // <Sidebar>/<TopBar> it renders consume host contexts — TopBar's `useTheme()`
  // (and any host shared primitive's `useToast`/`useOfflineStatus`). On /lsat the
  // host <App/> is NOT mounted, so these providers must live here or `useTheme()`
  // throws and blanks the whole page. SharedLayout is /lsat-only (the host App
  // renders its own chrome directly), so this never double-wraps the host route.
  // They read the same shared `qv-theme` store as LsatUnifiedMount's LSAT
  // ThemeProvider, so the two theme adapters stay in lockstep (UA2).
  return (
    <ThemeProvider>
    <ToastProvider>
    <OfflineProvider>
    <div className="app-layout">
      <a href="#main" className="skip-to-main">
        Skip to main content
      </a>

      <Sidebar
        collapsed={sidebarCollapsed}
        open={mobileNavOpen}
        mobileHidden={mobileNavHidden}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        onNavigate={() => setMobileNavOpen(false)}
        lsatMode={lsatMode}
      />
      <button
        type="button"
        className={`mobile-scrim ${mobileNavOpen ? 'open' : ''}`}
        aria-label="Close navigation"
        onClick={() => setMobileNavOpen(false)}
      />
      <TopBar
        collapsed={sidebarCollapsed}
        navOpen={mobileNavOpen}
        onMenuToggle={() => setMobileNavOpen((open) => !open)}
        lsatMode={lsatMode}
        onLsatModeChange={setLsatMode}
      />
      <main
        id="main"
        className={`main-content ${sidebarCollapsed ? 'collapsed' : ''}`}
        role="main"
        tabIndex={-1}
      >
        {children ?? <Outlet />}
      </main>
    </div>
    </OfflineProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}
