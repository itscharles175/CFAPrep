/**
 * LEARN-6 — adaptive next-objective recommendation card (host plane).
 *
 * Presentational card that renders the ranked candidates from the LSAT sidecar's
 * adaptive routing (`POST /api/adaptivity/next?domain=`, via {@link useNextQuestions}).
 * Each row shows the host objective, why the engine surfaced it (a shared reason
 * vocabulary — stretch / fluency check / gap repair / max information), its
 * predicted first-attempt success, and how well it sits inside the productive
 * "zone of proximal development" band. The most productive objective is first.
 *
 * Self-contained + degrading: it owns NO data fetching — the caller passes the
 * `report` from {@link useNextQuestions} plus `loading`/`onRefresh`. A down
 * sidecar (`report.reachable === false`) renders a graceful offline note rather
 * than an error, and an empty (but reachable) report renders a "keep studying"
 * empty state. Clicking a candidate (when `onSelect` is provided) hands the host
 * the `contentId`/`key` so it can open the matching Dexie content. This file does
 * NOT mount itself anywhere — a wiring agent places it.
 */
import { ArrowRight, RefreshCw, Sparkles } from 'lucide-react';
import { Surface, StatusBadge } from '../ui/Primitives';
import type {
  NextQuestionCandidate,
  NextQuestionReason,
  NextQuestionsReport,
} from '../../hooks/useNextQuestions';

/** Human label for each shared reason (falls back to a humanized key). */
const REASON_LABEL: Record<string, string> = {
  stretch: 'Stretch',
  fluency_check: 'Fluency check',
  recent_gap_review: 'Gap repair',
  maximum_information: 'Most informative',
};

/** Reason → StatusBadge tone (best-effort; unknown reasons use the accent tone). */
const REASON_TONE: Record<string, string> = {
  stretch: 'warning',
  fluency_check: 'success',
  recent_gap_review: 'danger',
  maximum_information: 'accent',
};

function reasonLabel(reason: NextQuestionReason): string {
  const key = String(reason);
  if (REASON_LABEL[key]) return REASON_LABEL[key];
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Recommended';
}

function reasonTone(reason: NextQuestionReason): string {
  return REASON_TONE[String(reason)] || 'accent';
}

/** Format a 0..1 probability as a whole-number percent. */
function pct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export interface AdaptiveRecommendationCardProps {
  /** The routing report from {@link useNextQuestions} (null before first load). */
  report: NextQuestionsReport | null;
  /** True while a fetch is in flight (shows a loading note + disables refresh). */
  loading?: boolean;
  /** Re-run the routing (wired to `useNextQuestions().refresh`). Optional. */
  onRefresh?: () => void;
  /**
   * Called when the user picks a candidate to study next. The host maps
   * `contentId`/`key` back to its Dexie content and opens the drill. When
   * omitted the rows render as static (non-interactive) summaries.
   */
  onSelect?: (candidate: NextQuestionCandidate) => void;
  /** Cap how many candidates are shown (the backend already ranks them). */
  maxItems?: number;
  className?: string;
}

export function AdaptiveRecommendationCard({
  report,
  loading = false,
  onRefresh,
  onSelect,
  maxItems = 5,
  className,
}: AdaptiveRecommendationCardProps) {
  const reachable = report?.reachable ?? false;
  const items = (report?.recommendations ?? []).slice(0, Math.max(0, maxItems));

  return (
    <Surface
      as="section"
      tone="analytics"
      className={['adaptive-recommendation-card', className].filter(Boolean).join(' ')}
      aria-label="Adaptive next objectives"
    >
      <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StatusBadge tone="accent">Adaptive routing</StatusBadge>
          <h3 className="qv-m-0 qv-mt-2">
            <Sparkles
              size={18}
              aria-hidden="true"
              style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }}
            />
            What to study next
            {report?.strategy && (
              <span className="qv-fs-sm qv-text-muted qv-mono" style={{ marginLeft: 'var(--space-2)' }}>
                {report.strategy.replace(/_/g, ' ')}
              </span>
            )}
          </h3>
          <p className="qv-text-secondary qv-m-0">
            Objectives ranked by expected learning value — picked against your unified ability so the
            next thing you do sits in the most productive difficulty band.
          </p>
          {typeof report?.mastery === 'number' && (
            <p className="qv-m-0 qv-mt-1 qv-fs-xs qv-text-muted qv-mono">
              current mastery {pct(report.mastery)}
            </p>
          )}
        </div>
        {onRefresh && (
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw size={14} style={{ marginRight: 'var(--space-1)' }} />
              {loading ? 'Routing…' : 'Refresh'}
            </button>
          </div>
        )}
      </div>

      <div className="qv-stack-3" style={{ marginTop: 'var(--space-4)' }}>
        {loading && !report ? (
          <p className="qv-m-0 qv-fs-sm qv-text-muted" role="status">
            Routing your next objectives…
          </p>
        ) : !reachable ? (
          <p className="qv-m-0 qv-fs-sm qv-text-muted">
            LSAT backend is offline — adaptive routing is unavailable. Start StudyVault&apos;s LSAT
            backend on :8100 to rank your next objectives.
          </p>
        ) : items.length === 0 ? (
          <p className="qv-m-0 qv-fs-sm qv-text-muted">
            No objectives to route yet — answer a few more questions to build a signal.
          </p>
        ) : (
          <ul
            className="qv-stack-2 qv-m-0"
            style={{ listStyle: 'none', padding: 0 }}
            aria-label="Recommended next objectives"
          >
            {items.map((candidate, index) => {
              const label = candidate.key || candidate.contentId;
              const interactive = Boolean(onSelect);
              const rowBody = (
                <>
                  <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'baseline' }}>
                    <span className="qv-fs-sm" style={{ fontWeight: 600, minWidth: 0 }}>
                      <span className="qv-text-muted qv-mono" style={{ marginRight: 'var(--space-1)' }}>
                        {index + 1}.
                      </span>
                      {label}
                    </span>
                    <StatusBadge tone={reasonTone(candidate.reason)}>
                      {reasonLabel(candidate.reason)}
                    </StatusBadge>
                  </div>
                  <div
                    className="qv-fs-xs qv-text-muted qv-mono"
                    style={{ marginTop: 'var(--space-1)', display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}
                  >
                    <span>success {pct(candidate.expectedSuccess)}</span>
                    <span>fit {pct(candidate.zpdFit)}</span>
                    <span>mastery {pct(candidate.masteryFraction)}</span>
                    {candidate.leech && <span className="qv-text-danger">leech</span>}
                  </div>
                </>
              );
              return (
                <li key={candidate.contentId || `${label}-${index}`}>
                  {interactive ? (
                    <button
                      type="button"
                      className="adaptive-recommendation-row qv-w-full"
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: '1px solid var(--border-subtle, transparent)',
                        borderRadius: 'var(--radius-2, 8px)',
                        padding: 'var(--space-2) var(--space-3)',
                        cursor: 'pointer',
                      }}
                      onClick={() => onSelect?.(candidate)}
                      aria-label={`Study ${label} — ${reasonLabel(candidate.reason)}, ${pct(candidate.expectedSuccess)} predicted success`}
                    >
                      {rowBody}
                      <ArrowRight
                        size={14}
                        aria-hidden="true"
                        style={{ float: 'right', marginTop: 'calc(-1 * var(--space-3))' }}
                      />
                    </button>
                  ) : (
                    <div
                      style={{
                        border: '1px solid var(--border-subtle, transparent)',
                        borderRadius: 'var(--radius-2, 8px)',
                        padding: 'var(--space-2) var(--space-3)',
                      }}
                    >
                      {rowBody}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Surface>
  );
}
