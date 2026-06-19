import type { CSSProperties } from 'react';
import { Skeleton } from './Skeleton';

// ---------------------------------------------------------------------------
// K4-4 — host route-shaped skeletons.
//
// The host shell only ships a single centered <RouteFallback> spinner, so a
// lazy route hard-cuts from a blank gap into a dense page. The LSAT domain long
// ago solved this with *layout-faithful* skeletons (SkeletonCard / SkeletonChart
// / SkeletonListPage / SkeletonDetailPage / DashboardSkeleton in
// src/domains/lsat/components/{states,dashboard/dashboard-skeleton}.tsx) that
// reserve the same boxes the loaded page fills, so the load reads as the page
// "settling in".
//
// This is the host-token twin of that vocabulary: the SAME component names and
// prop surfaces, composed from the shared host <Skeleton> primitive (which
// already inherits the C5 `.skeleton` shimmer + the app-wide
// prefers-reduced-motion suppression in src/index.css). The shapes use the host
// `--space-*` / `--radius-*` / `--bg-card` / `--glass-border` tokens — via the
// `.qv-skeleton-*` classes in src/index.css plus a few inline layout styles —
// rather than the @lsat/* Tailwind utilities the host shell cannot generate.
// A reskin can therefore import-swap an `@lsat/components/states` skeleton for
// the host one with no call-site churn and inherit the QuantVault look.
//
// NET-NEW: nothing imports these yet.
// ---------------------------------------------------------------------------

type PageWidth = 'md' | 'lg' | 'xl' | '2xl' | 'full';

// Mirrors the LSAT `PAGE_WIDTH` max-width scale, expressed as host inline
// max-width values (the host index.css is not Tailwind-processed, so utility
// classes like `max-w-2xl` would never be generated here).
const PAGE_MAX_WIDTH: Record<PageWidth, string> = {
  md: '42rem',
  lg: '56rem',
  xl: '64rem',
  '2xl': '72rem',
  full: 'none',
};

function pageContainerStyle(width: PageWidth): CSSProperties {
  return {
    marginInline: 'auto',
    width: '100%',
    maxWidth: PAGE_MAX_WIDTH[width],
    display: 'grid',
    gap: 'var(--space-6)',
  };
}

// ---------------------------------------------------------------------------
// Composable building blocks (host twins of the LSAT SkeletonCard / Chart).
// ---------------------------------------------------------------------------

export interface SkeletonCardProps {
  className?: string;
}

/** A card-shaped skeleton: a short label, a heading line, and two text lines. */
export function SkeletonCard({ className }: SkeletonCardProps) {
  return (
    <div className={['qv-skeleton-card', className].filter(Boolean).join(' ')}>
      <Skeleton variant="text" width="33%" />
      <Skeleton variant="heading" width="66%" />
      <Skeleton variant="text" />
      <Skeleton variant="text-medium" />
    </div>
  );
}

export interface SkeletonChartProps {
  className?: string;
}

/** A chart panel skeleton: a label over a tall plot block. */
export function SkeletonChart({ className }: SkeletonChartProps) {
  return (
    <div className={['qv-skeleton-card', className].filter(Boolean).join(' ')}>
      <Skeleton variant="text" width="25%" />
      <Skeleton height="12rem" />
    </div>
  );
}

/**
 * A PageLayout-shaped header block (icon chip + eyebrow + title + blurb, with a
 * trailing action). Internal; the page-shaped skeletons below compose it.
 */
function SkeletonPageHeader({ withIcon = true }: { withIcon?: boolean }) {
  return (
    <div className="qv-skeleton-page-header">
      <div className="qv-skeleton-page-header-lead">
        {withIcon && <Skeleton width={36} height={36} />}
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <Skeleton variant="text" width={80} height={10} />
          <Skeleton variant="heading" width={208} />
          <Skeleton variant="text" width={288} />
        </div>
      </div>
      <Skeleton width={112} height={36} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route-shaped skeletons (announced like the host LoadingState).
// ---------------------------------------------------------------------------

export interface SkeletonListPageProps {
  /** How many cards fill the responsive grid. */
  cards?: number;
  width?: PageWidth;
  className?: string;
}

/**
 * Generic list / index page (host: ReviewInbox, content libraries, history…):
 * a page header over a responsive card grid. `aria-busy` + a polite live label
 * keep it announced like the host LoadingState.
 */
export function SkeletonListPage({ cards = 6, width = 'xl', className }: SkeletonListPageProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={className}
      style={pageContainerStyle(width)}
    >
      <span className="sr-only">Loading…</span>
      <SkeletonPageHeader />
      <div className="qv-skeleton-card-grid">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

export interface SkeletonDetailPageProps {
  width?: PageWidth;
  className?: string;
}

/**
 * Generic detail / single-record page (host: analytics detail, settings…): a
 * page header over a wide primary panel and a narrow side rail of cards.
 */
export function SkeletonDetailPage({ width = 'lg', className }: SkeletonDetailPageProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={className}
      style={pageContainerStyle(width)}
    >
      <span className="sr-only">Loading…</span>
      <SkeletonPageHeader />
      <div className="qv-skeleton-detail-grid">
        <div className="qv-skeleton-card qv-skeleton-detail-main">
          <Skeleton variant="text" width="33%" />
          <Skeleton variant="text" />
          <Skeleton variant="text" width="92%" />
          <Skeleton variant="text" width="83%" />
          <Skeleton variant="text" width="75%" />
          <Skeleton height="10rem" />
        </div>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    </div>
  );
}

export interface SkeletonDashboardProps {
  className?: string;
}

/**
 * Dashboard loading state (host: the home dashboard) — host twin of the LSAT
 * `DashboardSkeleton`. Mirrors the real composition (resume band → hero metric →
 * a wide chart beside a narrow stat rail → a two-column card grid) so the first
 * paint reserves the same boxes the loaded dashboard fills.
 */
export function SkeletonDashboard({ className }: SkeletonDashboardProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={className}
      style={{ display: 'grid', gap: 'var(--space-6)' }}
    >
      <span className="sr-only">Loading…</span>

      {/* Resume-first hero band */}
      <div className="qv-skeleton-hero-band">
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <Skeleton variant="text" width={112} height={12} />
          <Skeleton variant="heading" width={224} />
        </div>
        <Skeleton width={160} height={44} />
      </div>

      {/* Engraved predicted-score hero (label + big numeral + counsel line) */}
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <Skeleton variant="text" width={128} height={12} />
        <Skeleton width={176} height={64} />
        <Skeleton variant="text" width={288} />
      </div>

      {/* Trend (wide) + stat rail (narrow) */}
      <div className="qv-skeleton-dashboard-row">
        <div className="qv-skeleton-card qv-skeleton-dashboard-wide">
          <Skeleton variant="text" width={128} />
          <Skeleton height="15rem" />
        </div>
        <div className="qv-skeleton-card">
          <Skeleton variant="text" width={96} />
          <Skeleton width={112} height={48} />
          <Skeleton variant="text" />
          <Skeleton variant="text" width="83%" />
        </div>
      </div>

      {/* Two-column card grid */}
      <div className="qv-skeleton-dashboard-grid">
        {[0, 1].map((i) => (
          <div key={i} className="qv-skeleton-card">
            <Skeleton variant="text" width={160} />
            <Skeleton variant="text" />
            <Skeleton variant="text" width="92%" />
            <Skeleton variant="text" width="75%" />
          </div>
        ))}
      </div>
    </div>
  );
}
