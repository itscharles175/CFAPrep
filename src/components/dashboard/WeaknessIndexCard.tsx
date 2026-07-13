import { Link } from 'react-router-dom';
import { ChevronRight, RefreshCw, Target } from 'lucide-react';
import { Panel, StatusBadge } from '../ui/Primitives';
import {
  useWeaknessIndex,
  type UseWeaknessIndexOptions,
  type WeaknessIndexItem,
} from '../../hooks/useWeaknessIndex';
import './dashboard-hierarchy.css';

/**
 * ANL-2 — unified weakness index Dashboard card.
 *
 * Surfaces the top few weakest areas ACROSS domains (LSAT per-type mastery + host
 * per-topic accuracy), ranked by the ~95% credible LOWER bound so a confidently-
 * weak area outranks a tiny noisy one. Each row deep-links straight to the
 * recommended drill (the backend-supplied `drillPath`), and the recent-miss count
 * tells the user how much fresh evidence backs the ranking.
 *
 * Two exports, mirroring the OPS-2 TrustReleasePanel split:
 *   - {@link WeaknessIndexCardView} is PRESENTATIONAL — all data via props, so it
 *     renders deterministically in tests with no network.
 *   - the default {@link WeaknessIndexCard} is SELF-CONTAINED — it wires
 *     {@link useWeaknessIndex} internally so the Dashboard (wired later) can mount
 *     it with zero prop plumbing.
 *
 * Fully degrading: when the LSAT sidecar is offline the hook resolves to
 * `reachable: false` and the card shows an offline hint instead of hanging.
 */

/** Format a 0..1 fraction as a whole-percent string, or an em dash when absent. */
function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** Short domain label for the per-row provenance chip. */
function domainLabel(domain: string): string {
  switch (domain) {
    case 'lsat':
      return 'LSAT';
    case 'cfa':
      return 'CFA';
    case 'quant':
      return 'Quant';
    case 'excel':
      return 'Excel';
    default:
      return domain.toUpperCase();
  }
}

export interface WeaknessIndexCardViewProps {
  /** Ranked weakness rows (weakest first). */
  items: WeaknessIndexItem[];
  /** True on the very first load (no cached payload yet). */
  loading: boolean;
  /** True while a refresh is in flight. */
  refreshing: boolean;
  /** False when the sidecar didn't answer. */
  reachable: boolean;
  /** ISO timestamp of the last successful fetch, if any. */
  fetchedAt: string | null;
  /** Force a re-fetch. */
  onRefresh: () => void;
  /** Cap the rows actually rendered (default 5). */
  maxRows?: number;
}

export function WeaknessIndexCardView({
  items,
  loading,
  refreshing,
  reachable,
  fetchedAt,
  onRefresh,
  maxRows = 5,
}: WeaknessIndexCardViewProps) {
  const rows = items.slice(0, maxRows);

  return (
    <Panel
      tone="analytics"
      status="warning"
      density="compact"
      className="dashboard-signal-card weakness-index-card"
    >
      <div className="dashboard-signal-head">
        <Target size={16} aria-hidden="true" />
        <span className="dashboard-signal-title">Weakest Areas</span>
        {rows.length > 0 && <span className="dashboard-signal-count">{items.length}</span>}
        <button
          type="button"
          className="weakness-index-refresh"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshing ? 'Refreshing weakness index' : 'Refresh weakness index'}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <p className="dashboard-signal-empty">Loading weakness index…</p>
      ) : !reachable ? (
        <p className="dashboard-signal-empty">
          LSAT backend is offline — weakness ranking is unavailable. Start the sidecar to see your
          cross-domain weak spots.
        </p>
      ) : rows.length === 0 ? (
        <p className="dashboard-signal-empty">
          No weak areas yet. Take a timed section or a drill to seed the cross-domain weakness
          index.
        </p>
      ) : (
        <ol className="dashboard-signal-list weakness-index-list" aria-label="Weakest areas, weakest first">
          {rows.map((item, idx) => (
            <li key={`${item.domain}:${item.key}:${idx}`}>
              <Link to={item.drillPath} className="dashboard-signal-link weakness-index-row">
                <span className="weakness-index-row-head">
                  <strong>{item.label}</strong>
                  <StatusBadge tone={item.domain === 'lsat' ? 'accent' : 'vault'}>
                    {domainLabel(item.domain)}
                  </StatusBadge>
                </span>
                <small className="weakness-index-row-meta">
                  {pct(item.accuracy)} accuracy · floor {pct(item.lowerBound)} · {item.attempts}{' '}
                  attempt{item.attempts === 1 ? '' : 's'}
                  {item.recentMissIds.length > 0 && (
                    <> · {item.recentMissIds.length} recent miss{item.recentMissIds.length === 1 ? '' : 'es'}</>
                  )}
                </small>
                <span className="weakness-index-row-cta">
                  Drill this <ChevronRight size={14} aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {fetchedAt && reachable && !loading && (
        <p className="weakness-index-footnote muted-copy">
          Ranked by reliability floor (95% credible lower bound). Updated{' '}
          {new Date(fetchedAt).toLocaleTimeString()}.
        </p>
      )}
    </Panel>
  );
}

export interface WeaknessIndexCardProps {
  /** Hook options forwarded to {@link useWeaknessIndex} (domain/days/limit/etc.). */
  options?: UseWeaknessIndexOptions;
  /** Cap the rows rendered (default 5). */
  maxRows?: number;
}

/**
 * Self-contained Dashboard card: wires {@link useWeaknessIndex} and renders the
 * presentational {@link WeaknessIndexCardView}. The Dashboard mounts THIS export
 * with no props (or just `options`).
 */
export function WeaknessIndexCard({ options, maxRows = 5 }: WeaknessIndexCardProps = {}) {
  const { items, loading, refreshing, reachable, fetchedAt, refresh } = useWeaknessIndex(options);
  return (
    <WeaknessIndexCardView
      items={items}
      loading={loading}
      refreshing={refreshing}
      reachable={reachable}
      fetchedAt={fetchedAt}
      onRefresh={refresh}
      maxRows={maxRows}
    />
  );
}

export default WeaknessIndexCard;
