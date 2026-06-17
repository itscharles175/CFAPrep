/**
 * UX-6 — cross-domain notification surface.
 *
 * Self-contained popover *content* for the TopBar bell. The bell button and the
 * `.notifications-popover` shell already live in `TopBar.tsx`; this component
 * renders only the inner list so the wiring agent can drop it inside the
 * existing popover without this file touching the hub.
 *
 * It folds the host's local due reviews together with the LSAT sidecar's
 * ability-ranked queue (LEARN-2, via `lsatReviewBridge.fetchUnifiedDue()` →
 * `progressStore.getCrossDomainUpcomingReviews()` → `useCrossDomainNotifications`)
 * into one proactive nudge: "N reviews due across CFA + LSAT".
 *
 * Routing per row:
 *   - host rows soft-navigate within the host router (react-router `Link`);
 *   - LSAT rows hard-hop into the vendored LSAT app via `navigateDomain` (the
 *     cross-domain CSS-isolation swap), since the host router can't reach them.
 *
 * Degrading by contract: the hook never throws. A down sidecar simply omits the
 * LSAT rows (with a quiet "LSAT offline" hint); a failed local read omits the
 * host rows. The surface always renders something.
 */
import { Link } from 'react-router-dom';
import { navigateDomain } from '../../lib/domainNav';
import {
  useCrossDomainNotifications,
  type CrossDomainNotificationsState,
} from '../../hooks/useProgress';
import type { CrossDomainNotification } from '../../lib/progressStore';

export interface NotificationCenterProps {
  /** Called after a row is activated so the host can close the popover. */
  onNavigate?: () => void;
  /** Max rows per domain (forwarded to the fold). Defaults to 5 each. */
  limit?: number;
  /**
   * Optional re-fold interval (ms) so a sidecar that comes back online is picked
   * up without a local write. Off by default (refresh on progress changes only).
   */
  pollMs?: number;
  /**
   * Pre-folded summary for testing / Storybook. When omitted (the normal path)
   * the component subscribes to {@link useCrossDomainNotifications} itself.
   */
  state?: CrossDomainNotificationsState;
}

const DOMAIN_BADGE: Record<CrossDomainNotification['domain'], string> = {
  cfa: 'CFA',
  lsat: 'LSAT',
  quant: 'Quant',
  excel: 'Excel',
};

function badgeLabel(domain: CrossDomainNotification['domain']): string {
  return DOMAIN_BADGE[domain] ?? domain.toUpperCase();
}

/** Headline that names exactly which domains contributed due items. */
function headline(cfaCount: number, lsatCount: number, total: number): string {
  if (total === 0) return 'No reviews due';
  const noun = total === 1 ? 'review' : 'reviews';
  if (cfaCount > 0 && lsatCount > 0) return `${total} ${noun} due across CFA + LSAT`;
  if (lsatCount > 0) return `${total} LSAT ${noun} due`;
  return `${total} CFA ${noun} due`;
}

function dueLabel(item: CrossDomainNotification): string {
  if (!item.dueAt) return badgeLabel(item.domain);
  const due = new Date(item.dueAt);
  if (Number.isNaN(due.getTime())) return badgeLabel(item.domain);
  return `${badgeLabel(item.domain)} · due ${due.toLocaleDateString()}`;
}

export function NotificationCenter({
  onNavigate,
  limit = 5,
  pollMs = 0,
  state,
}: NotificationCenterProps) {
  // `state` (tests/Storybook) short-circuits the live subscription. The hook is
  // still called unconditionally to respect the rules of hooks; its result is
  // simply ignored when an explicit `state` is supplied.
  const live = useCrossDomainNotifications({ limit, pollMs });
  const { notifications, total, cfaCount, lsatCount, lsatAvailable, indexedDbAvailable, loading } =
    state ?? live;

  function handleLsatRow(path: string) {
    navigateDomain(path);
    onNavigate?.();
  }

  return (
    <div className="notification-center" aria-busy={loading}>
      <div className="notifications-title">{headline(cfaCount, lsatCount, total)}</div>

      {notifications.length > 0 ? (
        <ul className="notification-list" role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {notifications.map((item) =>
            item.external ? (
              <li key={item.id}>
                <button
                  type="button"
                  className="notification-item notification-item-button"
                  // Inline reset so the button row matches the link rows without a
                  // hub CSS edit (index.css is owned elsewhere): strip the native
                  // button chrome, keep the shared `.notification-item` layout.
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    font: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                  onClick={() => handleLsatRow(item.path)}
                >
                  <span>{item.title}</span>
                  <small>{dueLabel(item)}</small>
                </button>
              </li>
            ) : (
              <li key={item.id}>
                <Link to={item.path} className="notification-item" onClick={() => onNavigate?.()}>
                  <span>{item.title}</span>
                  <small>{dueLabel(item)}</small>
                </Link>
              </li>
            ),
          )}
        </ul>
      ) : (
        <div className="notification-empty">
          {loading
            ? 'Checking for due reviews…'
            : indexedDbAvailable
              ? 'Nothing due right now — you are all caught up.'
              : 'Local study data is unavailable.'}
        </div>
      )}

      {/* Quiet hint when the LSAT sidecar is down: the surface still works, it
          just can't fold in LSAT rows right now. Never an error state. */}
      {!loading && !lsatAvailable && (
        <div className="notification-hint">LSAT reviews are offline (sidecar unavailable).</div>
      )}
    </div>
  );
}

export default NotificationCenter;
