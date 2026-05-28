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
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
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
