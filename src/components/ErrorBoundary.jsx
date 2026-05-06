import { Component } from 'react';

/**
 * A5: Granular error boundary that catches render errors and displays
 * a recovery UI instead of white-screening the entire app.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', this.props.name || 'unknown', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback({ error: this.state.error, reset: this.handleReset });
      }

      const level = this.props.level || 'section';
      const isPage = level === 'page';

      return (
        <div
          className={`glass-card no-hover ${isPage ? 'page-container' : ''}`}
          role="alert"
          style={{
            textAlign: 'center',
            padding: 'var(--space-8)',
            borderColor: 'rgba(239,68,68,0.25)',
          }}
        >
          <h2 style={{ marginBottom: 'var(--space-3)', color: 'var(--danger)' }}>
            {isPage ? 'Something went wrong' : 'This section encountered an error'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button type="button" className="btn btn-primary" onClick={this.handleReset}>
            Try Again
          </button>
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
export function DomainErrorBoundary({ name, children }) {
  return (
    <ErrorBoundary name={name} level="page">
      {children}
    </ErrorBoundary>
  );
}

/**
 * A5: Widget-level error boundary for isolating calculator/chart crashes.
 */
export function WidgetErrorBoundary({ name, children }) {
  return (
    <ErrorBoundary name={name} level="section">
      {children}
    </ErrorBoundary>
  );
}
