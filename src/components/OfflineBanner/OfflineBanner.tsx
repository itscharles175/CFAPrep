import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff, X } from 'lucide-react';
import { useOfflineStatus, type OfflineReason } from '../../context/OfflineContext';
import './OfflineBanner.css';

/**
 * BA3 — visible, dismissible banner for a degraded RAG stack.
 *
 * Renders only when {@link useOfflineStatus} reports a degradation; the silent
 * Dexie fallback otherwise hides sidecar outages, so this is the user-facing
 * cue that RAG answers are unavailable. The Retry button re-probes immediately.
 *
 * Accessibility: a hard browser-offline is announced assertively (role="alert");
 * a softer "RAG unavailable" advisory uses role="status" + aria-live="polite"
 * so it doesn't interrupt. Dismiss is per-degradation — if the reason changes
 * (e.g. browser-offline → sidecars-down) the banner returns so the user isn't
 * left unaware of a *new* problem.
 */

interface BannerCopy {
  title: string;
  detail: string;
}

function copyForReason(reason: OfflineReason): BannerCopy {
  switch (reason) {
    case 'browser-offline':
      return {
        title: 'You are offline',
        detail: 'Network connection lost. Saved study data still works; RAG and AI features will resume when you reconnect.',
      };
    case 'sidecars-down':
      return {
        title: 'RAG unavailable',
        detail: 'The local search services are not responding. Retry once they have started.',
      };
    default:
      return { title: '', detail: '' };
  }
}

export default function OfflineBanner() {
  const { isOffline, reason, retry } = useOfflineStatus();
  // Dismissal is keyed to the specific reason so a *new* kind of degradation
  // re-surfaces the banner even after an earlier one was dismissed.
  const [dismissedReason, setDismissedReason] = useState<OfflineReason | null>(null);

  // Clear the dismissal once the stack recovers, so the next outage shows again.
  useEffect(() => {
    if (!isOffline) setDismissedReason(null);
  }, [isOffline]);

  if (!isOffline || reason === 'ok' || dismissedReason === reason) return null;

  const { title, detail } = copyForReason(reason);
  // A lost network connection is the more urgent, interrupting case.
  const assertive = reason === 'browser-offline';

  function handleRetry() {
    // Re-probe immediately; if it clears, the provider flips isOffline and the
    // banner unmounts on the next render.
    retry();
  }

  return (
    <div
      className="offline-banner"
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      <span className="offline-banner-icon" aria-hidden="true">
        <WifiOff size={16} />
      </span>
      <span className="offline-banner-body">
        <span className="offline-banner-title">{title}</span>
        <span className="offline-banner-detail">{detail}</span>
      </span>
      <span className="offline-banner-actions">
        <button type="button" className="offline-banner-retry" onClick={handleRetry}>
          <RefreshCw size={14} aria-hidden="true" /> Retry
        </button>
        <button
          type="button"
          className="offline-banner-dismiss"
          aria-label="Dismiss offline notice"
          onClick={() => setDismissedReason(reason)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
