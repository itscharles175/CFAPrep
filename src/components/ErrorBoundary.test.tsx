import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary, { readLastCrash, clearLastCrash } from './ErrorBoundary';

function Boom({ when = true }: { when?: boolean }) {
  if (when) throw new Error('kaboom');
  return <div>safe content</div>;
}

describe('ErrorBoundary (P5 enhancements)', () => {
  beforeEach(() => {
    clearLastCrash();
    // The boundary logs the caught error; silence it so the run stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearLastCrash();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary name="t">
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('catches a render error and shows the recovery UI', () => {
    render(
      <ErrorBoundary name="t" level="section">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('This section encountered an error')).toBeInTheDocument();
  });

  it('persists the last crash to localStorage', () => {
    render(
      <ErrorBoundary name="crash-test">
        <Boom />
      </ErrorBoundary>,
    );
    const crash = readLastCrash();
    expect(crash).not.toBeNull();
    expect(crash?.message).toBe('kaboom');
    expect(crash?.name).toBe('crash-test');
    expect(typeof crash?.ts).toBe('number');
  });

  it('clears the caught error when resetKey changes', () => {
    const { rerender } = render(
      <ErrorBoundary name="t" resetKey="a">
        <Boom when />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // New resetKey + a non-throwing subtree → boundary recovers and renders it.
    rerender(
      <ErrorBoundary name="t" resetKey="b">
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('safe content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clearLastCrash removes the persisted entry', () => {
    render(
      <ErrorBoundary name="t">
        <Boom />
      </ErrorBoundary>,
    );
    expect(readLastCrash()).not.toBeNull();
    clearLastCrash();
    expect(readLastCrash()).toBeNull();
  });
});
