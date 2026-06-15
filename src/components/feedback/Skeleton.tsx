import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// UB5 — host Skeleton primitives. The host already ships the shimmer styling
// (`.skeleton`, `.skeleton-text`, `.skeleton-card`, … in src/index.css, the
// "Skeleton Loading (C5)" block) but only as raw class names sprinkled across
// pages. This wraps them in typed React components so every host domain reaches
// for the same loading shapes via the shared feedback barrel, matching the
// ergonomics of the LSAT `Skeleton` / `SkeletonList` exports without dragging
// in the @lsat/* Tailwind utilities.
// ---------------------------------------------------------------------------

type SkeletonVariant =
  | 'text'
  | 'text-short'
  | 'text-medium'
  | 'heading'
  | 'card'
  | 'metric'
  | 'avatar'
  | 'block';

const VARIANT_CLASS: Record<SkeletonVariant, string> = {
  text: 'skeleton-text',
  'text-short': 'skeleton-text short',
  'text-medium': 'skeleton-text medium',
  heading: 'skeleton-heading',
  card: 'skeleton-card',
  metric: 'skeleton-metric',
  avatar: 'skeleton-avatar',
  block: '',
};

export interface SkeletonProps {
  /** A preset shape from the host C5 skeleton scale. Defaults to a bare block. */
  variant?: SkeletonVariant;
  /** Inline width override (e.g. '60%' or 120). */
  width?: number | string;
  /** Inline height override (e.g. '1.5rem' or 48). */
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ variant = 'block', width, height, className, style }: SkeletonProps) {
  const classes = ['skeleton', VARIANT_CLASS[variant], className].filter(Boolean).join(' ');
  return (
    <div
      aria-hidden="true"
      className={classes}
      style={{ width, height, ...style }}
    />
  );
}

export interface SkeletonListProps {
  /** How many avatar + two-line rows to render. */
  rows?: number;
  className?: string;
}

/** A polite, announced list-of-rows skeleton (avatar + two text lines each). */
export function SkeletonList({ rows = 5, className }: SkeletonListProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={['skeleton-list', className].filter(Boolean).join(' ')}
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skeleton-list-row"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
        >
          <Skeleton variant="avatar" />
          <div style={{ flex: 1, display: 'grid', gap: 'var(--space-2)' }}>
            <Skeleton variant="text" width="66%" />
            <Skeleton variant="text-short" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
