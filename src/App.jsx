import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import TopBar from './components/Layout/TopBar';
import ErrorBoundary, { DomainErrorBoundary } from './components/ErrorBoundary';
import EmptyState from './components/EmptyState';
import { Dialog } from './components/ui/Primitives';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { appRoutes } from './routes/routeManifest';

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
const PwaInstallPrompt = lazy(() => import('./components/PwaInstallPrompt'));

/* C5: Skeleton loading state instead of text-only fallback */
function RouteFallback() {
  return (
    <div className="page-container" aria-busy="true" aria-label="Loading page">
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

function routeElementFor(definition, element) {
  if (definition.boundary === 'domain') {
    return <DomainErrorBoundary name={definition.boundaryName}>{element}</DomainErrorBoundary>;
  }
  return element;
}

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const location = useLocation();
  const mobileNavWasOpen = useRef(false);
  const mobileNavHidden = mobileViewport && !mobileNavOpen;
  const routeElements = {
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
    'knowledge-graph': <KnowledgeGraph />,
    style: <StyleGallery />,
  };

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
    function handleKeyDown(event) {
      // `?` opens the keyboard-help dialog; skip if the user is typing into a
      // text field (avoid hijacking question-mark in inputs/textareas).
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      event.preventDefault();
      setHelpOpen(true);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) {
      if (mobileNavWasOpen.current) document.querySelector('.mobile-menu-button')?.focus?.();
      mobileNavWasOpen.current = false;
      return undefined;
    }
    mobileNavWasOpen.current = true;
    document.querySelector('#main-sidebar a, #main-sidebar button')?.focus?.();
    function handleKeyDown(event) {
      if (event.key === 'Escape') setMobileNavOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileNavOpen]);

  return (
    <ThemeProvider>
      <ToastProvider>
        <div className="app-layout">
          {/* G1: Skip to main content link for keyboard/screen reader users */}
          <a href="#main-content" className="skip-link">
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
          {/* G1: Proper <main> landmark with id for skip-link target */}
          <main
            id="main-content"
            className={`main-content ${sidebarCollapsed ? 'collapsed' : ''}`}
            role="main"
          >
            {/* P5: resetKey={pathname} auto-clears a caught crash on navigation,
                so a bad page doesn't strand the user on the error screen. */}
            <ErrorBoundary name="app-root" level="page" resetKey={location.pathname}>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  {appRoutes.map((definition) => (
                    <Route
                      key={definition.id}
                      path={definition.path}
                      element={routeElementFor(definition, routeElements[definition.id])}
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
          </main>
          {helpOpen && (
            <Dialog
              title="Keyboard shortcuts"
              description="Global shortcuts plus this route's scopes. Press Esc or click outside to close."
              onClose={() => setHelpOpen(false)}
              actions={
                <button className="btn btn-primary" onClick={() => setHelpOpen(false)}>Got it</button>
              }
            >
              <section style={{ marginBottom: 'var(--space-4)' }}>
                <h4 style={{ margin: '0 0 var(--space-2)' }}>Global</h4>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <kbd>Ctrl+K</kbd> <kbd>Cmd+K</kbd>
                    <span>Open command palette</span>
                  </li>
                  <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <kbd>?</kbd>
                    <span>Open this help dialog</span>
                  </li>
                  <li style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <kbd>Esc</kbd>
                    <span>Close dialog or palette</span>
                  </li>
                </ul>
              </section>
              {(() => {
                const route = appRoutes.find((r) => r.path === location.pathname)
                  || appRoutes.find((r) => r.path.endsWith('/*') && location.pathname.startsWith(r.path.slice(0, -2)))
                  || appRoutes.find((r) => {
                    const prefix = r.path.split('/:')[0];
                    return prefix && prefix !== '/' && location.pathname.startsWith(prefix);
                  });
                if (!route || route.keyboardHelp.length === 0) return null;
                return (
                  <section>
                    <h4 style={{ margin: '0 0 var(--space-2)' }}>This page · {route.navLabel}</h4>
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      {route.keyboardHelp.map((entry, index) => (
                        <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                          {entry.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                          <span style={{ textTransform: 'capitalize' }}>{entry.label}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })()}
            </Dialog>
          )}
          <Suspense fallback={null}>
            <PwaInstallPrompt />
          </Suspense>
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
}
