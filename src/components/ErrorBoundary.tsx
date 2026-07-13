import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { EmptyPanel } from './ui/Primitives';

export interface ErrorBoundaryFallbackProps {
  error: Error | null;
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children?: ReactNode;
  name?: string;
  level?: 'page' | 'section';
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode;
  /**
   * P5: when this value changes, the boundary clears its captured error so the
   * subtree re-mounts — e.g. pass `resetKey={location.pathname}` so navigating
   * away from a crashed route recovers automatically. (Ported from the LSAT
   * boundary's resetKey API.)
   */
  resetKey?: unknown;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/** P5: shape of the last render crash persisted to localStorage. */
export interface LastCrash {
  message: string;
  stack: string;
  componentStack: string;
  route: string;
  name: string;
  ts: number;
}

const LAST_CRASH_KEY = 'studyvault.lastCrash';

/** P5: read the last persisted render crash (null if none / unreadable). */
export function readLastCrash(): LastCrash | null {
  try {
    const raw = localStorage.getItem(LAST_CRASH_KEY);
    return raw ? (JSON.parse(raw) as LastCrash) : null;
  } catch {
    return null;
  }
}

/** P5: clear the persisted crash (called from the System Health readout). */
export function clearLastCrash(): void {
  try {
    localStorage.removeItem(LAST_CRASH_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * A5: Granular error boundary that catches render errors and displays
 * a recovery UI instead of white-screening the entire app.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.name || 'unknown', error, info.componentStack);

    // P5: persist the last crash locally so System Health can surface it — a
    // local-first app has no remote telemetry. Truncated + try/catch so a
    // localStorage write failure never masks the original error. (Ported from
    // the LSAT boundary's crash-persistence behaviour.)
    try {
      const entry: LastCrash = {
        message: error.message,
        stack: (error.stack ?? '').slice(0, 4000),
        componentStack: (info.componentStack ?? '').slice(0, 4000),
        route: typeof window !== 'undefined' ? window.location.pathname : '',
        name: this.props.name || 'unknown',
        ts: Date.now(),
      };
      localStorage.setItem(LAST_CRASH_KEY, JSON.stringify(entry));
    } catch {
      /* ignore write errors */
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // P5: clear the captured error when the caller's resetKey changes so the
    // subtree re-mounts (e.g. after navigating away from a crashed route).
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.handleReset();
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback({ error: this.state.error, reset: this.handleReset });
      }

      const level = this.props.level || 'section';
      const isPage = level === 'page';

      return (
        <div className={isPage ? 'page-container' : undefined} role="alert">
          <EmptyPanel
            tone="default"
            className="surface-status-danger"
            title={isPage ? 'Something went wrong' : 'This section encountered an error'}
            description={this.state.error?.message || 'An unexpected error occurred.'}
            action={
              <button type="button" className="btn btn-primary" onClick={this.handleReset}>
                Try Again
              </button>
            }
          />
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * A5: Domain-level error boundary for isolating domain crashes.
 * Use around each domain route group so a crash in CFA doesn't
 * affect Quant or Excel.
 */
export function DomainErrorBoundary({ name, children }: { name?: string; children?: ReactNode }) {
  return (
    <ErrorBoundary name={name} level="page">
      {children}
    </ErrorBoundary>
  );
}

/**
 * A5: Widget-level error boundary for isolating calculator/chart crashes.
 */
export function WidgetErrorBoundary({ name, children }: { name?: string; children?: ReactNode }) {
  return (
    <ErrorBoundary name={name} level="section">
      {children}
    </ErrorBoundary>
  );
}
