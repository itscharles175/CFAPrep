import { Suspense, lazy, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import TopBar from './components/Layout/TopBar';
import ErrorBoundary from './components/ErrorBoundary';
import EmptyState from './components/EmptyState';
import { ThemeProvider } from './context/ThemeContext';

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

function RouteFallback() {
  return (
    <div className="page-container">
      <div className="glass-card no-hover route-fallback">Loading QuantVault...</div>
    </div>
  );
}

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <ThemeProvider>
      <div className="app-layout">
        <Sidebar
          collapsed={sidebarCollapsed}
          open={mobileNavOpen}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          onNavigate={() => setMobileNavOpen(false)}
        />
        <button
          type="button"
          className={`mobile-scrim ${mobileNavOpen ? 'open' : ''}`}
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
        <TopBar collapsed={sidebarCollapsed} onMenuToggle={() => setMobileNavOpen((open) => !open)} />
        <main className={`main-content ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <ErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/cfa" element={<CfaDashboard />} />
                <Route path="/cfa/:level/:topic" element={<CfaModule />} />
                <Route path="/cfa/:level/:topic/quiz" element={<CfaQuiz />} />
                <Route path="/cfa/:level/:topic/vignette" element={<CfaVignette />} />
                <Route path="/cfa/:level/:topic/constructed-response" element={<CfaConstructedResponse />} />
                <Route path="/quant" element={<QuantDashboard />} />
                <Route path="/quant/:module" element={<QuantModule />} />
                <Route path="/excel" element={<ExcelDashboard />} />
                <Route path="/excel/:module" element={<ExcelModule />} />
                <Route path="/calculators" element={<Calculators />} />
                <Route path="/formulas" element={<FormulaLibrary />} />
                <Route path="/review" element={<ReviewInbox />} />
                <Route path="/vault" element={<VaultCenter />} />
                <Route path="/flashcards" element={<Flashcards />} />
                <Route path="/cfa/mock" element={<MockExam />} />
                <Route path="/cfa/:level/mock" element={<MockExam />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/content-ops" element={<ContentOps />} />
                <Route path="/system" element={<SystemHealth />} />
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
    </ThemeProvider>
  );
}
