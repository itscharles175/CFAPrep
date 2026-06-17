/**
 * INT-5 — Generation Quality panel for the System Health page.
 *
 * Surfaces the LSAT generation pipeline's quality from two derived, read-only
 * backend feeds (via {@link useGenerationQualityMetrics}):
 *   - a SUMMARY row (jobs / candidates / overall pass rate),
 *   - a PER-GATE breakdown of the 8+ pipeline gates (structural, trap-metadata,
 *     deterministic-solve, self-consistency, permutation-invariance, lexical-leak,
 *     CoVe, multi-model-agreement, RC-authenticity, novelty, …) — each with its
 *     judged/passed/failed counts, a pass-rate bar, and its top failure reason,
 *   - the worst-performing q_types (lowest pass rate), and
 *   - a recent AUDIT FEED of generate / validate / firewall events.
 *
 * Self-contained (a later wiring agent mounts it into SystemHealth.jsx) and fully
 * degrading, matching the rest of System Health: a down/slow sidecar leaves the
 * panel visible with an honest "offline" note rather than throwing. Bars are tiny
 * inline elements — no chart lib, no shared viz barrel, zero new deps. Uses the
 * same `qv-*` utility + `Surface`/`StatusBadge` primitives as the sibling panels.
 *
 * LOCAL-ONLY: every figure is read from the on-device sidecar; nothing is sent
 * anywhere and nothing is written back.
 */

import { useMemo, type CSSProperties } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Sparkles, WifiOff } from 'lucide-react';
import { StatusBadge, Surface } from '../ui/Primitives';
import {
  useGenerationQualityMetrics,
  type GenAuditEvent,
  type GenAuditKind,
  type GenGateMetric,
  type UseGenerationQualityMetrics,
} from '../../hooks/useGenerationQualityMetrics';

/** Allow tests / a parent to inject a stub hook result; defaults to the live hook. */
export interface GenerationQualityPanelProps {
  /** Override the audit-feed window (1..500). Defaults to 50. */
  auditLimit?: number;
  /**
   * Injected hook value (testing seam). When omitted the panel calls
   * {@link useGenerationQualityMetrics} itself. Lets the System Health page (or a
   * test) provide a fixture without a live sidecar.
   */
  state?: UseGenerationQualityMetrics;
}

function pct(rate: number | null): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`;
}

type Tone = 'success' | 'warning' | 'danger' | 'muted';

/** Pass-rate tone: green >= 0.85, amber >= 0.6, red below. */
function rateTone(rate: number | null): Tone {
  if (rate == null) return 'muted';
  if (rate >= 0.85) return 'success';
  if (rate >= 0.6) return 'warning';
  return 'danger';
}

const TONE_VAR: Record<Tone, string> = {
  success: 'var(--color-success, #16a34a)',
  warning: 'var(--color-warning, #d97706)',
  danger: 'var(--color-danger, #dc2626)',
  muted: 'var(--color-text-muted, #9ca3af)',
};

const ROW_BORDER = '1px solid var(--color-border, rgba(0,0,0,0.06))';

/** A compact horizontal pass-rate bar (no chart lib). */
function RateBar({ rate }: { rate: number | null }) {
  const tone = rateTone(rate);
  const widthPct = rate == null ? 0 : Math.round(rate * 100);
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 64,
        height: 6,
        borderRadius: 3,
        background: 'var(--color-border, rgba(0,0,0,0.1))',
        overflow: 'hidden',
        flex: '0 0 auto',
      }}
    >
      <span
        style={{ display: 'block', width: `${widthPct}%`, height: '100%', background: TONE_VAR[tone] }}
      />
    </span>
  );
}

/** The single most common failure reason for a gate, if any. */
function topFailReason(reasons: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of Object.entries(reasons)) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

const AUDIT_TONE: Record<GenAuditKind, Tone> = {
  generate: 'success',
  validate: 'warning',
  firewall: 'danger',
};

const AUDIT_LABEL: Record<GenAuditKind, string> = {
  generate: 'Generated',
  validate: 'Quarantined',
  firewall: 'Firewall',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  padding: 'var(--space-1) 0',
  borderBottom: ROW_BORDER,
};

function AuditRow({ event }: { event: GenAuditEvent }) {
  return (
    <li style={ROW_STYLE}>
      <StatusBadge tone={AUDIT_TONE[event.kind]}>{AUDIT_LABEL[event.kind]}</StatusBadge>
      <span className="qv-fs-sm qv-fw-semibold">{event.qType || 'Unknown'}</span>
      {event.reason && <span className="qv-fs-xs qv-text-muted">· {event.reason}</span>}
      <span className="qv-fs-xs qv-text-muted qv-ml-auto" title={event.createdAt || undefined}>
        {relativeTime(event.createdAt)}
      </span>
    </li>
  );
}

/**
 * INT-5 panel. Self-contained; mount into the System Health page (see the
 * wiring instructions in the PR). Renders nothing destructive — purely a
 * read-only observability surface.
 */
export function GenerationQualityPanel({ auditLimit = 50, state }: GenerationQualityPanelProps) {
  // The hook is always called (rules of hooks); when a fixture `state` is
  // injected we simply ignore the live value.
  const live = useGenerationQualityMetrics({ auditLimit });
  const { metrics, auditLog, loading, refreshing, reachable, fetchedAt, refresh } = state ?? live;

  // Worst 5 q_types by pass rate (only those with at least one judged candidate).
  const worstTypes = useMemo(() => {
    const rows = (metrics?.byType ?? []).filter((t) => t.passed + t.failed > 0);
    return [...rows].sort((a, b) => (a.passRate ?? 1) - (b.passRate ?? 1)).slice(0, 5);
  }, [metrics]);

  const overallTone = rateTone(metrics?.passRate ?? null);

  return (
    <Surface as="section" tone="ops" className="qv-stack-3" aria-labelledby="genq-heading">
      <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
        <h3 className="qv-m-0 qv-row-1" style={{ alignItems: 'center' }}>
          <Sparkles size={18} aria-hidden="true" />
          <span id="genq-heading">Generation Quality</span>
          {!reachable && (
            <StatusBadge tone="muted" icon={WifiOff}>
              Sidecar offline
            </StatusBadge>
          )}
        </h3>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={refresh}
          disabled={refreshing}
          aria-label="Refresh generation quality metrics"
        >
          <RefreshCw size={14} aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && !metrics ? (
        <p className="qv-text-muted qv-fs-sm qv-m-0">Loading generation metrics…</p>
      ) : !reachable && !metrics ? (
        <p className="qv-text-muted qv-fs-sm qv-m-0">
          The LSAT sidecar is offline, so generation-quality metrics are unavailable. Start the
          sidecar from the console above to populate this panel.
        </p>
      ) : !metrics || metrics.totalCandidates === 0 ? (
        <p className="qv-text-muted qv-fs-sm qv-m-0">
          No generation jobs have run yet. Once Tier-B drills are generated, per-gate pass rates and
          the validate/firewall audit feed appear here.
        </p>
      ) : (
        <>
          {/* Summary row. */}
          <div className="qv-row-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusBadge
              tone={overallTone}
              icon={overallTone === 'success' ? ShieldCheck : AlertTriangle}
            >
              {pct(metrics.passRate)} pass rate
            </StatusBadge>
            <span className="qv-fs-sm qv-text-muted">
              {metrics.passed}/{metrics.totalCandidates} candidates passed · {metrics.jobs} job
              {metrics.jobs === 1 ? '' : 's'} · {metrics.quarantined} quarantined
            </span>
          </div>

          {/* Per-gate breakdown. */}
          <div className="qv-stack-1">
            <h4 className="qv-m-0 qv-fs-sm qv-fw-semibold">Per-gate pass rates</h4>
            <div role="table" aria-label="Generation gate pass rates">
              {metrics.gates.map((gate: GenGateMetric) => {
                const reason = topFailReason(gate.failReasons);
                return (
                  <div role="row" key={gate.gate} style={ROW_STYLE}>
                    <span className="qv-fs-sm" style={{ minWidth: 160 }}>
                      {gate.gate}
                    </span>
                    <RateBar rate={gate.passRate} />
                    <span className={`qv-fs-xs qv-text-${rateTone(gate.passRate)}`} style={{ minWidth: 42 }}>
                      {gate.judged === 0 ? '—' : pct(gate.passRate)}
                    </span>
                    <span className="qv-fs-xs qv-text-muted">
                      {gate.judged === 0 ? 'not run' : `${gate.passed}/${gate.judged} judged`}
                    </span>
                    {gate.failed > 0 && reason && (
                      <span className="qv-fs-xs qv-text-danger qv-ml-auto">
                        {gate.failed}× {reason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Worst q_types. */}
          {worstTypes.length > 0 && (
            <div className="qv-stack-1">
              <h4 className="qv-m-0 qv-fs-sm qv-fw-semibold">Lowest pass-rate question types</h4>
              <ul className="qv-m-0" style={{ listStyle: 'none', padding: 0 }}>
                {worstTypes.map((t) => (
                  <li key={t.qType} style={ROW_STYLE}>
                    <span className="qv-fs-sm" style={{ minWidth: 160 }}>
                      {t.qType}
                    </span>
                    <RateBar rate={t.passRate} />
                    <span className={`qv-fs-xs qv-text-${rateTone(t.passRate)}`} style={{ minWidth: 42 }}>
                      {pct(t.passRate)}
                    </span>
                    <span className="qv-fs-xs qv-text-muted">
                      {t.passed}/{t.passed + t.failed}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Audit feed. */}
          <div className="qv-stack-1">
            <h4 className="qv-m-0 qv-fs-sm qv-fw-semibold qv-row-1" style={{ alignItems: 'center' }}>
              <CheckCircle2 size={14} aria-hidden="true" />
              <span>Recent events</span>
              {auditLog && (
                <span className="qv-fs-xs qv-text-muted">
                  ({auditLog.counts.generate ?? 0} gen · {auditLog.counts.validate ?? 0} quarantined ·{' '}
                  {auditLog.counts.firewall ?? 0} firewall)
                </span>
              )}
            </h4>
            {auditLog && auditLog.events.length > 0 ? (
              <ul className="qv-m-0" style={{ listStyle: 'none', padding: 0 }} aria-label="Recent generation events">
                {auditLog.events.map((event) => (
                  <AuditRow key={`${event.id ?? 'x'}-${event.candidateIndex}`} event={event} />
                ))}
              </ul>
            ) : (
              <p className="qv-text-muted qv-fs-xs qv-m-0">No recent generation events.</p>
            )}
          </div>
        </>
      )}

      {fetchedAt && (
        <p className="qv-fs-xs qv-text-muted qv-m-0">Updated {relativeTime(fetchedAt)}</p>
      )}
    </Surface>
  );
}

export default GenerationQualityPanel;
