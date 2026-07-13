import type { ReactNode } from 'react';
import { AlertTriangle, WifiOff } from 'lucide-react';
import { Surface } from '../ui/Primitives';

// ---------------------------------------------------------------------------
// UB5 — host ErrorState. The LSAT domain ships its own bespoke ErrorState in
// src/domains/lsat/components/states.tsx, but it leans on @lsat/* aliases
// (ApiError, IllustrationError, Tailwind utilities) that the host shell does
// not have. This is the host-token twin: it speaks the host's `surface`
// primitive, CSS-variable palette and `btn` classes so CFA / Quant / Excel
// pages get the same calm error language through one shared barrel.
// ---------------------------------------------------------------------------

export interface ErrorStateProps {
  /** The thrown value (Error, string, or anything). Drives the body copy. */
  error?: unknown;
  /** Optional explicit title; defaults adapt to offline vs generic failures. */
  title?: ReactNode;
  /** Retry callback — renders a "Retry" button when provided. */
  onRetry?: () => void;
  /** Custom illustration / icon node, overriding the default lucide glyph. */
  icon?: ReactNode;
  className?: string;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}

export function ErrorState({ error, title, onRetry, icon, className }: ErrorStateProps) {
  const message = messageFromError(error);
  const offline =
    message.toLowerCase().includes('fetch') || message.toLowerCase().includes('network');

  return (
    <Surface
      status="danger"
      role="alert"
      className={['error-state', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-3)',
        textAlign: 'center',
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--danger)', lineHeight: 0 }}>
        {icon ?? (offline ? <WifiOff size={28} /> : <AlertTriangle size={28} />)}
      </span>
      <h2 style={{ margin: 0 }}>
        {title ?? (offline ? 'Backend not reachable' : 'Could not load data')}
      </h2>
      <p style={{ margin: 0, maxWidth: '32rem', color: 'var(--text-secondary)' }}>
        {offline
          ? 'Is the local backend running at the configured address? You can keep working; data will appear once it is up.'
          : message}
      </p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </Surface>
  );
}

export default ErrorState;
