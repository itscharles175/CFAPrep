/**
 * OPS-2 — trust + release-readiness cockpit panel.
 *
 * Renders the LSAT backend's release-trust manifest (built by
 * `services/lsat-backend/app/trust.py`) as a cockpit card: a rollup status
 * (`ok | warning | blocked`), an expandable per-check tree, the flat
 * `next_actions` list, and the always-available host-only checks folded in
 * (offline readiness, Dexie quota, SurrealDB/LSAT liveness).
 *
 * Presentational + degrading: it owns only its expand/collapse state and reads
 * everything else from {@link useTrustManifest}. A down/slow sidecar shows a
 * graceful "offline" note over the host checks rather than an error.
 */
import { useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Surface, StatusBadge } from './Primitives';
import type {
  HostCheck,
  TrustCheck,
  TrustCheckStatus,
  TrustManifest,
  TrustRollup,
} from '../../hooks/useTrustManifest';

/** Map a rollup status to the Surface tone-status used across the page. */
const ROLLUP_SURFACE_STATUS: Record<TrustRollup, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  warning: 'warning',
  blocked: 'danger',
};

/** Map a rollup status to a StatusBadge tone. */
const ROLLUP_BADGE_TONE: Record<TrustRollup, string> = {
  ok: 'success',
  warning: 'warning',
  blocked: 'danger',
};

const ROLLUP_LABEL: Record<TrustRollup, string> = {
  ok: 'Ready',
  warning: 'Warnings',
  blocked: 'Blocked',
};

/** Per-check status → badge tone. The backend uses the short `block`/`warn` forms. */
const CHECK_BADGE_TONE: Record<TrustCheckStatus, string> = {
  ok: 'success',
  warn: 'warning',
  block: 'danger',
};

const CHECK_LABEL: Record<TrustCheckStatus, string> = {
  ok: 'ok',
  warn: 'warn',
  block: 'block',
};

/** Turn `release_local` → `Release local` for a readable check title. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface TrustReleasePanelProps {
  manifest: TrustManifest | null;
  loading: boolean;
  refreshing: boolean;
  reachable: boolean;
  hostChecks: HostCheck[];
  fetchedAt: string | null;
  onRefresh: () => void;
}

export function TrustReleasePanel({
  manifest,
  loading,
  refreshing,
  reachable,
  hostChecks,
  fetchedAt,
  onRefresh,
}: TrustReleasePanelProps) {
  const [expanded, setExpanded] = useState(false);
  // The rollup follows the backend manifest when present; otherwise the worst
  // host-check status so the card still signals risk with the sidecar down.
  const rollup: TrustRollup = manifest
    ? manifest.status
    : worstHostStatus(hostChecks);
  const checkEntries = manifest ? Object.entries(manifest.checks) : [];

  return (
    <Surface
      tone="ops"
      status={loading ? undefined : ROLLUP_SURFACE_STATUS[rollup]}
      className="ops-report-panel"
      aria-label="Trust and release readiness"
    >
      <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StatusBadge tone="ops">Trust &amp; Release</StatusBadge>
          <h3 className="qv-m-0 qv-mt-2">
            <ShieldCheck
              size={18}
              aria-hidden="true"
              style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }}
            />
            Release readiness{' '}
            {!loading && (
              <StatusBadge tone={ROLLUP_BADGE_TONE[rollup]}>{ROLLUP_LABEL[rollup]}</StatusBadge>
            )}
            {manifest?.score != null && (
              <span className="qv-fs-sm qv-text-muted qv-mono" style={{ marginLeft: 'var(--space-2)' }}>
                score {manifest.score}/100
              </span>
            )}
          </h3>
          <p className="qv-text-secondary qv-m-0">
            A single auditable rollup of local-first safety signals — backend integrity, content
            health, privacy firewall, model readiness, migrations, backups, and the release gate —
            plus host-side offline readiness and storage headroom.
          </p>
          {fetchedAt && (
            <p className="qv-m-0 qv-mt-1 qv-fs-xs qv-text-muted qv-mono">
              last checked {new Date(fetchedAt).toLocaleTimeString()}
              {manifest?.tier ? ` · tier ${manifest.tier}` : ''}
            </p>
          )}
        </div>
        <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={14} style={{ marginRight: 'var(--space-1)' }} />
            {refreshing ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="qv-m-0 qv-mt-4 qv-fs-sm qv-text-muted" role="status">
          Loading trust manifest…
        </p>
      ) : (
        <div className="qv-stack-3" style={{ marginTop: 'var(--space-4)' }}>
          {!reachable && (
            <p className="qv-m-0 qv-fs-sm qv-text-muted">
              LSAT backend is offline — showing host-side checks only. Start StudyVault&apos;s LSAT
              backend on :8100 for the full release gate.
            </p>
          )}

          {/* Next actions — the flat, deduped to-do list the backend derives. */}
          {manifest && manifest.next_actions.length > 0 && (
            <div>
              <h4 className="qv-m-0 qv-fs-sm">Next actions</h4>
              <ul className="qv-mt-1 qv-mb-0 qv-fs-sm" aria-label="Next actions">
                {manifest.next_actions.map((action, i) => (
                  <li key={i}>{action}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Host-side checks — always available, even with the sidecar down. */}
          {hostChecks.length > 0 && (
            <div>
              <h4 className="qv-m-0 qv-fs-sm">Host checks</h4>
              <div className="qv-stack-2 qv-mt-1">
                {hostChecks.map((check) => (
                  <div key={check.key} className="qv-row-2" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <StatusBadge tone={ROLLUP_BADGE_TONE[check.status]}>
                      {ROLLUP_LABEL[check.status]}
                    </StatusBadge>
                    <strong className="qv-fs-sm">{check.label}</strong>
                    <span className="qv-fs-sm qv-text-muted">{check.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Backend check tree — collapsed by default to keep the card compact. */}
          {checkEntries.length > 0 && (
            <div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-controls="trust-check-tree"
              >
                {expanded ? 'Hide checks' : `Show ${checkEntries.length} backend checks`}
              </button>
              {expanded && (
                <div id="trust-check-tree" className="qv-stack-2 qv-mt-3">
                  {checkEntries.map(([key, check]) => (
                    <CheckRow key={key} name={key} check={check} />
                  ))}
                </div>
              )}
            </div>
          )}

          {!manifest && reachable && (
            <p className="qv-m-0 qv-fs-sm qv-text-muted">
              The backend did not return a trust manifest. The host-side checks above still apply.
            </p>
          )}
        </div>
      )}
    </Surface>
  );
}

/** One backend check row — badge, humanized title, summary, and any detail keys. */
function CheckRow({ name, check }: { name: string; check: TrustCheck }) {
  const detailEntries = check.detail ? Object.entries(check.detail) : [];
  return (
    <div
      className="surface surface-default surface-compact"
      style={{ padding: 'var(--space-3)' }}
    >
      <div className="qv-row-2" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <StatusBadge tone={CHECK_BADGE_TONE[check.status]}>{CHECK_LABEL[check.status]}</StatusBadge>
        <strong className="qv-fs-sm">{humanizeKey(name)}</strong>
      </div>
      {check.summary && (
        <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-muted">{check.summary}</p>
      )}
      {check.action && (
        <p className="qv-m-0 qv-mt-1 qv-fs-sm">
          <span className="qv-text-muted">Action: </span>
          {check.action}
        </p>
      )}
      {detailEntries.length > 0 && (
        <dl className="qv-mt-2 qv-mb-0 qv-fs-xs qv-mono qv-text-muted" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--space-2)', rowGap: 2 }}>
          {detailEntries.map(([dk, dv]) => (
            <div key={dk} style={{ display: 'contents' }}>
              <dt>{dk}</dt>
              <dd className="qv-m-0" style={{ wordBreak: 'break-word' }}>
                {formatDetailValue(dv)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Render an arbitrary detail value compactly (arrays/objects → JSON). */
function formatDetailValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Worst-of the host-check statuses, for the rollup when the manifest is absent. */
function worstHostStatus(hostChecks: HostCheck[]): TrustRollup {
  let worst: TrustRollup = 'ok';
  for (const check of hostChecks) {
    if (check.status === 'blocked') return 'blocked';
    if (check.status === 'warning') worst = 'warning';
  }
  return worst;
}

export default TrustReleasePanel;
