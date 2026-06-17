/**
 * ANL-4 — green/amber/red readiness checklist (presentational).
 *
 * A one-glance "am I ready?" cockpit row, scored from the SHIPPED cross-domain
 * reads (per-domain ability curves + the DATA-6 study profile) by the pure
 * `scoreReadiness` shaper in `dashboardMetrics.ts`. Nine dimensions:
 * goal · trajectory · mastery · evidence · blind-review control · calibration ·
 * pacing · reviews (SRS) · plateau watch.
 *
 * Pure presentation: it takes already-scored {@link ReadinessCheck}s and renders
 * them with a traffic-light dot + verdict. An `unknown` dimension is shown grey
 * ("not enough signal") rather than a misleading pass/fail — honest degradation
 * is the whole point of the host-only backport.
 *
 * Rides the unified design tokens (semantic success/warning/danger hues,
 * --surface-*, --text-*, --space-*, --fs-*, --radius-*) via inline styles so it
 * needs no new global CSS file. A11y: the list is a labelled group; each row's
 * status is conveyed in text (not color alone) for screen readers + colorblind
 * users.
 */
import type { CSSProperties } from 'react';
import type { ReadinessCheck, ReadinessStatus } from '../../lib/dashboardMetrics';
import { aggregateReadiness } from '../../lib/dashboardMetrics';

export interface DashboardReadinessChecklistProps {
  /** The scored checklist rows (from `scoreReadiness`). */
  checks: ReadinessCheck[];
  /**
   * Optional pre-computed headline status. When omitted it is derived from the
   * rows via `aggregateReadiness` so the caller need not duplicate the roll-up.
   */
  headline?: ReadinessStatus;
  className?: string;
}

const STATUS_META: Record<ReadinessStatus, { color: string; word: string; bg: string }> = {
  green: { color: 'var(--success, #16a34a)', word: 'On track', bg: 'var(--success-soft, rgba(22,163,74,0.12))' },
  amber: { color: 'var(--warning, #d97706)', word: 'Watch', bg: 'var(--warning-soft, rgba(217,119,6,0.12))' },
  red: { color: 'var(--danger, #dc2626)', word: 'Needs work', bg: 'var(--danger-soft, rgba(220,38,38,0.12))' },
  unknown: { color: 'var(--text-muted, #94a3b8)', word: 'No signal', bg: 'var(--surface-muted, rgba(148,163,184,0.1))' },
};

function StatusDot({ status }: { status: ReadinessStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: meta.color,
        boxShadow: status === 'unknown' ? 'none' : `0 0 0 3px ${meta.bg}`,
      }}
    />
  );
}

function ChecklistRow({ check }: { check: ReadinessCheck }) {
  const meta = STATUS_META[check.status];
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-2, 8px)',
    padding: 'var(--space-2, 8px) 0',
    borderTop: '1px solid var(--border, rgba(148,163,184,0.14))',
  };
  return (
    <li style={rowStyle}>
      <span style={{ marginTop: 3 }}>
        <StatusDot status={check.status} />
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, flex: 1 }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 'var(--space-2, 8px)',
            flexWrap: 'wrap',
          }}
        >
          <strong
            style={{
              fontSize: 'var(--fs-sm, 13px)',
              fontWeight: 700,
              color: 'var(--text-primary, #e2e8f0)',
            }}
          >
            {check.label}
          </strong>
          <span
            style={{
              fontSize: 'var(--fs-xs, 11px)',
              fontWeight: 600,
              color: meta.color,
            }}
          >
            {/* status word ensures meaning is not color-only */}
            {meta.word}
          </span>
        </span>
        <span
          style={{
            fontSize: 'var(--fs-xs, 11px)',
            color: 'var(--text-secondary, #94a3b8)',
            lineHeight: 1.4,
          }}
        >
          {check.detail}
        </span>
      </span>
    </li>
  );
}

/**
 * The readiness checklist card body. Renders nothing when given no checks (the
 * parent owns the empty state). The header shows the rolled-up headline status.
 */
export function DashboardReadinessChecklist({
  checks,
  headline,
  className,
}: DashboardReadinessChecklistProps) {
  if (!checks || checks.length === 0) return null;
  const status = headline ?? aggregateReadiness(checks);
  const meta = STATUS_META[status];
  const greenCount = checks.filter((c) => c.status === 'green').length;
  const scoredCount = checks.filter((c) => c.status !== 'unknown').length;

  const headStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2, 8px)',
    marginBottom: 'var(--space-2, 8px)',
  };

  return (
    <section
      className={className}
      aria-label="Exam-readiness checklist"
      style={{
        padding: 'var(--space-3, 12px)',
        borderRadius: 'var(--radius-lg, 12px)',
        background: 'var(--surface-raised, rgba(148,163,184,0.06))',
        border: '1px solid var(--border, rgba(148,163,184,0.18))',
      }}
    >
      <header style={headStyle}>
        <StatusDot status={status} />
        <span
          style={{
            fontSize: 'var(--fs-sm, 13px)',
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--text-primary, #e2e8f0)',
          }}
        >
          Readiness
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--fs-xs, 11px)',
            fontWeight: 700,
            color: meta.color,
          }}
        >
          {meta.word}
          {scoredCount > 0 ? ` · ${greenCount}/${scoredCount} green` : ''}
        </span>
      </header>

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {checks.map((check) => (
          <ChecklistRow key={check.id} check={check} />
        ))}
      </ul>
    </section>
  );
}

export default DashboardReadinessChecklist;
