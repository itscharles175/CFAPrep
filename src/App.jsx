import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import TopBar from './components/Layout/TopBar';
import ErrorBoundary, { DomainErrorBoundary } from './components/ErrorBoundary';
import EmptyState from './components/EmptyState';
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
  };

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setMobileViewport(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
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
            <ErrorBoundary name="app-root" level="page">
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
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
}
