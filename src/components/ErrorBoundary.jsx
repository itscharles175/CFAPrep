import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('QuantVault route error', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="page-container">
          <div className="glass-card no-hover empty-state">
            <h2>Something broke in this view</h2>
            <p>Refresh the page or jump back to the dashboard while the route recovers.</p>
            <button className="btn btn-primary" onClick={() => window.location.assign('/')}>
              Back to Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
