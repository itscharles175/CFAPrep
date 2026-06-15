import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { StatusBadge, Surface } from '../ui/Primitives';
import {
  dismissResumePrompt,
  getOnboardingProgress,
  isResumePromptDismissed,
  ONBOARDING_TOTAL_STEPS,
} from '../../lib/onboardingProgress';

// ---------------------------------------------------------------------------
// UB7 — onboarding "resume / you're ready" prompt.
//
// Reads the synchronous onboarding progress high-water mark (see
// lib/onboardingProgress) and surfaces ONE of two unobtrusive, dismissible
// states on Today:
//
//   • resumable  — the user started the wizard but bailed partway. We nudge them
//                  to pick up where they left off via the host onboarding flow.
//   • complete   — onboarding finished. We show a quiet "you're ready" pat on the
//                  back the first time, then it stays dismissed.
//
// Brand-new users (step 0) see nothing — onboarding itself handles them. The
// prompt is gated behind its own per-state dismissal flag so it never re-nags.
// ---------------------------------------------------------------------------

export interface OnboardingResumeProps {
  /**
   * Invoked when the user clicks "Resume onboarding". The host owns the wizard
   * (Dashboard renders it); Today wires this to navigation so the wrapper stays
   * decoupled from where onboarding actually lives.
   */
  onResume?: () => void;
  /** Optional className passthrough for layout (e.g. margin). */
  className?: string;
}

type PromptState = 'hidden' | 'resumable' | 'complete';

function resolveState(): PromptState {
  if (isResumePromptDismissed()) return 'hidden';
  const { resumable, complete } = getOnboardingProgress();
  if (resumable) return 'resumable';
  if (complete) return 'complete';
  return 'hidden';
}

export function OnboardingResume({ onResume, className }: OnboardingResumeProps) {
  // Resolve once on mount (and re-resolve if the tab regains focus, e.g. the
  // user finished onboarding in another part of the app and came back).
  const [state, setState] = useState<PromptState>('hidden');

  useEffect(() => {
    setState(resolveState());
    function onFocus() {
      setState(resolveState());
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (state === 'hidden') return null;

  function handleDismiss() {
    dismissResumePrompt();
    setState('hidden');
  }

  const isResumable = state === 'resumable';
  const { step } = getOnboardingProgress();
  const reachedStep = Math.min(step, ONBOARDING_TOTAL_STEPS);

  return (
    <Surface
      tone="study"
      density="compact"
      status={isResumable ? 'accent' : 'success'}
      className={className}
      role="status"
      aria-live="polite"
      style={{ marginBottom: 'var(--space-6)' }}
    >
      <div
        className="flex-between qv-row-3-start"
        style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <span style={{ flexShrink: 0, display: 'inline-flex', opacity: 0.9, marginTop: 2 }}>
            <Sparkles size={20} aria-hidden="true" />
          </span>
          <div>
            <StatusBadge tone={isResumable ? 'accent' : 'success'}>
              {isResumable ? 'Pick up where you left off' : "You're ready"}
            </StatusBadge>
            <p className="muted-copy qv-mt-1 qv-m-0">
              {isResumable
                ? `You got to step ${reachedStep} of ${ONBOARDING_TOTAL_STEPS} in setup. Finish connecting a local model and your sources to unlock grounded drills.`
                : 'Setup is complete — your local model and sources are wired up. Jump straight into today’s plan below.'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
          {isResumable && onResume && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                handleDismiss();
                onResume();
              }}
            >
              Resume setup
            </button>
          )}
          <button
            className="btn-icon btn-ghost"
            onClick={handleDismiss}
            aria-label="Dismiss onboarding prompt"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </Surface>
  );
}
