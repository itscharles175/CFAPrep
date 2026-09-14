import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import MobileWorkspaceNav from './components/Layout/MobileWorkspaceNav';
import TopBar from './components/Layout/TopBar';
import ErrorBoundary, { DomainErrorBoundary } from './components/ErrorBoundary';
import EmptyState from './components/EmptyState';
import KeyboardHelp from './components/KeyboardHelp/KeyboardHelp';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { OfflineProvider } from './context/OfflineContext';
import OfflineBanner from './components/OfflineBanner';
import { StudySessionProvider } from './components/session';
import { appRoutes } from './routes/routeManifest';
import { prefersReducedMotion } from './lib/viewTransitions';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const CfaDashboard = lazy(() => import('./domains/cfa/CfaDashboard'));
const CfaModule = lazy(() => import('./domains/cfa/CfaModule'));
const CfaQuiz = lazy(() => import('./domains/cfa/CfaQuiz'));
const CfaVignette = lazy(() => import('./domains/cfa/CfaVignette'));
const CfaConstructedResponse = lazy(() => import('./domains/cfa/CfaConstructedResponse'));
const QuantDashboard = lazy(() => import('./domains/quant/QuantDashboard'));
const QuantModule = lazy(() => import('./domains/quant/QuantModule'));
const ExcelDashboard = lazy(() => import('./domains/excel/ExcelDashboard'));
const ExcelModule = lazy(() => import('./domains/excel/ExcelModule'));
const Calculators = lazy(() => import('./pages/Calculators'));
const FormulaLibrary = lazy(() => import('./pages/FormulaLibrary'));
const ReviewInbox = lazy(() => import('./pages/ReviewInbox'));
const VaultCenter = lazy(() => import('./pages/VaultCenter'));
const Flashcards = lazy(() => import('./pages/Flashcards'));
const MockExam = lazy(() => import('./pages/MockExam'));
const Analytics = lazy(() => import('./pages/Analytics'));
const ContentOps = lazy(() => import('./pages/ContentOps'));
const SystemHealth = lazy(() => import('./pages/SystemHealth'));
const Today = lazy(() => import('./pages/Today'));
const KnowledgeGraph = lazy(() => import('./pages/KnowledgeGraph'));
const StyleGallery = lazy(() => import('./pages/StyleGallery'));
const LeechesAndGaps = lazy(() => import('./pages/LeechesAndGaps'));
const Settings = lazy(() => import('./pages/Settings'));
const TutorWorkspace = lazy(() => import('./pages/TutorWorkspace'));
const PwaInstallPrompt = lazy(() => import('./components/PwaInstallPrompt'));

export const hostRouteElements = {
  dashboard: <Dashboard />,
  'cfa-dashboard': <CfaDashboard />,
  'cfa-module': <CfaModule />,
  'cfa-quiz': <CfaQuiz />,
  'cfa-vignette': <CfaVignette />,
  'cfa-constructed-response': <CfaConstructedResponse />,
  'quant-dashboard': <QuantDashboard />,
  'quant-module': <QuantModule />,
  'excel-dashboard': <ExcelDashboard />,
  'excel-module': <ExcelModule />,
  calculators: <Calculators />,
  formulas: <FormulaLibrary />,
  review: <ReviewInbox />,
  vault: <VaultCenter />,
  flashcards: <Flashcards />,
  mock: <MockExam />,
  'level-mock': <MockExam />,
  analytics: <Analytics />,
  'content-ops': <ContentOps />,
  system: <SystemHealth />,
  today: <Today />,
  'today-alias': <Today />,
  'knowledge-graph': <KnowledgeGraph />,
  'tutor-workspace': <TutorWorkspace />,
  style: <StyleGallery />,
  leeches: <LeechesAndGaps />,
  preferences: <Settings />,
};

/*
 * UX-5 — host soft-nav route-transition state.
 *
 * The LSAT plane already animates route changes (its own <GlobalLoadingBar> +
 * <SuspenseSignal>); the host previously swapped lazy pages with no top-level
 * "something is loading" cue beyond the per-page skeleton. This brings the host
 * to parity with a CSS-only top progress bar (no motion dependency):
 *
 *   - <RouteProgressSignal> mounts inside the route Suspense fallback, so the bar
 *     is visible for EXACTLY as long as a lazy route chunk is actually suspended,
 *     then completes when the real page commits and the fallback unmounts.
 *   - A `pathname` change also gives a brief self-completing acknowledgment, so
 *     already-cached routes (which never suspend) still register a transition.
 *
 * The width animation + fade live in CSS (.route-progress* in index.css), which
 * the existing prefers-reduced-motion block neutralizes for free.
 */
const RouteProgressCtx = createContext(null);

/** Drop inside a Suspense fallback to drive the host route-progress bar from real
 *  suspense state. Renders nothing; no-op outside the provider. */
function RouteProgressSignal() {
  const api = useContext(RouteProgressCtx);
  useEffect(() => {
    if (!api) return undefined;
    api.begin();
    return () => api.end();
  }, [api]);
  return null;
}

function RouteProgressBar({ pathname, children }) {
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const pending = useRef(0);
  const trickle = useRef(null);
  const hideTimer = useRef(null);

  const clearTrickle = () => {
    if (trickle.current != null) {
      window.clearInterval(trickle.current);
      trickle.current = null;
    }
  };

  const show = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setVisible(true);
    setWidth((w) => (w < 12 ? 12 : w));
    if (trickle.current == null) {
      // Ease toward — but never reach — 90%; the bar can't know true progress.
      trickle.current = window.setInterval(() => {
        setWidth((w) => (w >= 90 ? w : w + Math.max(0.6, (90 - w) * 0.12)));
      }, 120);
    }
  }, []);

  const finish = useCallback(() => {
    clearTrickle();
    setWidth(100);
    hideTimer.current = window.setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 220);
  }, []);

  const begin = useCallback(() => {
    pending.current += 1;
    show();
  }, [show]);

  const end = useCallback(() => {
    pending.current = Math.max(0, pending.current - 1);
    if (pending.current === 0) finish();
  }, [finish]);

  // Cached routes never suspend — give each navigation a brief, self-completing
  // acknowledgment. The begin is scheduled on the next frame (not run inline in
  // the effect body) so it doesn't synchronously setState during the effect, and
  // is only balanced by `end()` if it actually began. The cleanup guarantees the
  // pair nets to zero so `pending` can never strand above zero (which would
  // freeze the bar visible); `began`/`acked` guard against double counting.
  useEffect(() => {
    let began = false;
    let acked = false;
    const raf = window.requestAnimationFrame(() => {
      began = true;
      begin();
    });
    const ack = () => {
      if (acked) return;
      acked = true;
      if (began) end();
    };
    const t = window.setTimeout(ack, 160);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
      ack();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(
    () => () => {
      clearTrickle();
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  return (
    <RouteProgressCtx.Provider value={{ begin, end }}>
      <div
        className={`route-progress ${visible ? 'visible' : ''}`}
        role="progressbar"
        aria-label="Page loading"
        aria-hidden={!visible}
        aria-valuenow={Math.round(width)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="route-progress-fill" style={{ width: `${width}%` }} />
      </div>
      {children}
    </RouteProgressCtx.Provider>
  );
}

/* C5: Skeleton loading state instead of text-only fallback.
   UX-5: also drives the top route-progress bar while suspended. */
function RouteFallback() {
  return (
    <div className="page-container" aria-busy="true" aria-label="Loading page">
      <RouteProgressSignal />
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-text" />
      <div className="skeleton skeleton-text medium" />
      <div className="grid-3" style={{ marginTop: 'var(--space-6)' }}>
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
    </div>
  );
}

function RouteStage({ pathname, children }) {
  const stageRef = useRef(null);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || prefersReducedMotion() || typeof node.animate !== 'function') return undefined;
    const animation = node.animate(
      [
        { opacity: 0.86, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' },
    );
    return () => animation.cancel();
  }, [pathname]);

  return <div ref={stageRef} className="route-stage">{children}</div>;
}

function routeElementFor(definition, element) {
  if (definition.boundary === 'domain') {
    return <DomainErrorBoundary name={definition.boundaryName}>{element}</DomainErrorBoundary>;
  }
  return element;
}

function focusFirstVisibleSidebarTarget() {
  const targets = Array.from(document.querySelectorAll('#main-sidebar a[href], #main-sidebar button:not([disabled])'));
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

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const location = useLocation();
  const mobileNavWasOpen = useRef(false);
  const mobileNavHidden = mobileViewport && !mobileNavOpen;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setMobileViewport(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  // Per-domain accent: drive a `data-domain` attribute on <body> from the URL.
  // tokens.css overrides --color-accent and --accent under matching selectors
  // so chips, callouts, and buttons re-tint without per-component changes.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const path = location.pathname;
    let domain = '';
    if (path.startsWith('/cfa')) domain = 'cfa';
    else if (path.startsWith('/excel')) domain = 'excel';
    else if (path.startsWith('/quant')) domain = 'quant';
    // K4-accent: /lsat/* tints the cascade with the LSAT violet. Inert under the
    // legacy shell (LsatRoot owns /lsat, not this host App), it takes effect once
    // K4-7 mounts LSAT in the host router; SharedLayout already sets it too.
    else if (path.startsWith('/lsat')) domain = 'lsat';
    if (domain) {
      document.body.setAttribute('data-domain', domain);
    } else {
      document.body.removeAttribute('data-domain');
    }
    return () => {
      // Cleanup runs on unmount or before the next effect — leaving the
      // attribute in place between transitions avoids a flash to the default
      // accent while the next route is loading.
    };
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen) {
      if (mobileNavWasOpen.current) document.querySelector('.mobile-menu-button')?.focus?.();
      mobileNavWasOpen.current = false;
      return undefined;
    }
    mobileNavWasOpen.current = true;
    const focusTimer = window.setTimeout(focusFirstVisibleSidebarTarget, 0);
    function handleKeyDown(event) {
      if (event.key === 'Escape') setMobileNavOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileNavOpen]);

  return (
    <ThemeProvider>
      <ToastProvider>
        <OfflineProvider>
        <StudySessionProvider>
        <div className="app-layout">
          {/* BA3: RAG/sidecar-aware offline banner — visible only when degraded,
              sits above the shell so the user knows AI/search is unavailable
              rather than silently empty (the Dexie fallback otherwise hides it). */}
          <OfflineBanner />
          {/* UC1: Skip to main content — first focusable child of the app shell,
              visually hidden until focused (see .skip-to-main in index.css). */}
          <a href="#main" className="skip-to-main">
            Skip to main content
          </a>

          <Sidebar
            collapsed={sidebarCollapsed}
            open={mobileNavOpen}
            mobileHidden={mobileNavHidden}
            onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
            onNavigate={() => setMobileNavOpen(false)}
          />
          <button
            type="button"
            className={`mobile-scrim ${mobileNavOpen ? 'open' : ''}`}
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          />
          <TopBar collapsed={sidebarCollapsed} navOpen={mobileNavOpen} onMenuToggle={() => setMobileNavOpen((open) => !open)} />
          {/* UC1: Primary scrolling content region — <main id="main"> is the
              skip-to-main target and the page landmark. */}
          <main
            id="main"
            className={`main-content ${sidebarCollapsed ? 'collapsed' : ''}`}
            role="main"
            tabIndex={-1}
          >
            {/* UX-5: route-transition progress bar. The provider wraps the route
                Suspense boundary so <RouteProgressSignal> (mounted in the fallback)
                can drive it from real suspense state, plus a per-navigation nudge. */}
            <RouteProgressBar pathname={location.pathname}>
            <RouteStage pathname={location.pathname}>
            {/* P5: resetKey={pathname} auto-clears a caught crash on navigation,
                so a bad page doesn't strand the user on the error screen. */}
            <ErrorBoundary name="app-root" level="page" resetKey={location.pathname}>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  {appRoutes.map((definition) => (
                    <Route
                      key={definition.id}
                      path={definition.path}
                      element={routeElementFor(definition, hostRouteElements[definition.id])}
                    />
                  ))}
                  <Route
                    path="*"
                    element={
                      <EmptyState
                        title="Page not found"
                        description="That route is not in the vault yet."
                        actionLabel="Back to Dashboard"
                        actionTo="/"
                      />
                    }
                  />
                </Routes>
              </Suspense>
            </ErrorBoundary>
            </RouteStage>
            </RouteProgressBar>
          </main>
          <MobileWorkspaceNav />
          {/* UB6: shared "?" keyboard-help overlay — owns its own open state
              (the `?` key and the TopBar help button both reach it). */}
          <KeyboardHelp />
          {/* Crash-isolation: this optional install banner is a lazy chunk that
              can go stale after a deploy. It sits OUTSIDE the route ErrorBoundary,
              so without its own boundary a rejected import would bubble to the
              root boundary and replace the whole app. It's non-essential, so a
              failed chunk degrades to nothing (fallback={() => null}). */}
          <ErrorBoundary name="pwa-install-prompt" fallback={() => null}>
            <Suspense fallback={null}>
              <PwaInstallPrompt />
            </Suspense>
          </ErrorBoundary>
        </div>
        </StudySessionProvider>
        </OfflineProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
