import { ArrowLeft } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { performBack, resolveBack } from '../lib/history-aware-back';
import { useNavigationHistory } from '../lib/navigationHistory';

/*
 * UX-4 — the shared, history-aware Back button.
 *
 * One button, used by the host TopBar. It reads the cross-domain navigation
 * trail (re-rendering whenever it changes via `useNavigationHistory`) and the
 * current path, resolves where "Back" should land, and on click runs
 * `performBack` — which soft-hops cross-domain when the previous location is in
 * the other plane, else delegates to the supplied same-domain navigator.
 *
 * Accessibility: aria-label is "Back to <prev>" so the destination is announced;
 * the button is disabled at the root of the trail (nowhere to go back to).
 */

interface NavBackButtonProps {
  /** Active-router back (host: `() => navigate(-1)`). Falls back to history.back(). */
  onSameDomainBack?: () => void;
  className?: string;
}

export default function NavBackButton({ onSameDomainBack, className }: NavBackButtonProps) {
  const { pathname } = useLocation();
  // Subscribe to the trail so the resolution (and disabled state) stays live.
  useNavigationHistory();
  const { canGoBack, target } = resolveBack(pathname);

  const label = canGoBack && target ? `Back to ${target.label}` : 'Back';

  return (
    <button
      type="button"
      className={`btn-icon btn-ghost nav-back-button ${className ?? ''}`.trim()}
      aria-label={label}
      title={label}
      disabled={!canGoBack}
      onClick={() => performBack(pathname, onSameDomainBack)}
    >
      <ArrowLeft size={18} />
    </button>
  );
}
