import { useEffect, useState } from 'react';
import { Sparkles, PlayCircle, X } from 'lucide-react';
import { StatusBadge, Surface } from '../ui/Primitives';
import {
  dismissResumePrompt,
  getOnboardingProgress,
  isResumePromptDismissed,
  ONBOARDING_TOTAL_STEPS,
} from '../../lib/onboardingProgress';
import {
  getUnifiedResume,
  getUnifiedResumeSync,
  type UnifiedResume,
} from '../../lib/unifiedResume';

// ---------------------------------------------------------------------------
// UB7 + UX-3 — onboarding "resume / you're ready" prompt, now CROSS-DOMAIN.
//
// Originally (UB7) this surfaced one of two host-only onboarding states from the
// synchronous onboarding high-water mark:
//
//   • resumable  — the user started the host wizard but bailed partway,
//   • complete   — onboarding finished ("you're ready").
//
// UX-3 makes it domain-agnostic. Instead of reading host onboarding progress
// directly, it asks the unified-resume arbiter (`lib/unifiedResume`) for the
// single MOST-RECENT resumable thing across BOTH planes:
//
//   • onboarding     — the same finish-setup / you're-ready nudge as before,
//   • lsat-session   — a concrete in-progress LSAT section/exam/drill with a
//                      route (surfaced with a "Continue" CTA that navigates),
//   • host-activity  — the host plane's most-recent study session.
//
// At first paint it uses the SYNCHRONOUS slice (onboarding + LSAT pointer, no
// flash), then folds in the async host-activity probe in an effect and on focus.
// Brand-new users still see nothing. The prompt is still gated behind its own
// per-state dismissal flag so it never re-nags.
// ---------------------------------------------------------------------------

export interface OnboardingResumeProps {
  /**
   * Invoked when the user clicks "Resume onboarding". The host owns the wizard
   * (Dashboard renders it); Today wires this to navigation so the wrapper stays
   * decoupled from where onboarding actually lives.
   */
  onResume?: () => void;
  /**
   * UX-3 — invoked with an in-app route when the winning resume is a concrete
   * session (LSAT section/exam/drill, or host activity) rather than onboarding.
   * The caller navigates there (e.g. react-router `navigate(path)`), keeping this
   * wrapper decoupled from any router. When omitted, the session is still shown
   * but without a Continue CTA.
   */
  onResumeSession?: (path: string) => void;
  /** Optional className passthrough for layout (e.g. margin). */
  className?: string;
}

export function OnboardingResume({ onResume, onResumeSession, className }: OnboardingResumeProps) {
  // Resolve synchronously at first paint (no flash), then refine with the async
  // host-activity probe. Re-resolve when the tab regains focus (e.g. the user
  // finished onboarding / a session elsewhere and came back).
  const [resume, setResume] = useState<UnifiedResume | null>(() =>
    isResumePromptDismissed() ? null : getUnifiedResumeSync(),
  );

  useEffect(() => {
    let active = true;
    function resolveSync() {
      if (isResumePromptDismissed()) {
        setResume(null);
        return;
      }
      setResume(getUnifiedResumeSync());
    }
    async function resolveFull() {
      if (isResumePromptDismissed()) {
        if (active) setResume(null);
        return;
      }
      const r = await getUnifiedResume();
      // Re-check dismissal AFTER the await: a dismiss (or another resolve) can
      // land while this async probe is in flight, and we must not re-show a
      // prompt the user just dismissed.
      if (active && !isResumePromptDismissed()) setResume(r);
    }
    void resolveFull();
    function onFocus() {
      resolveSync();
      void resolveFull();
    }
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!resume) return null;

  function handleDismiss() {
    dismissResumePrompt();
    setResume(null);
  }

  // The "you're ready" success tone is only for completed onboarding; every other
  // winner (mid-onboarding, an in-progress session) uses the accent "pick up
  // where you left off" tone.
  const isComplete =
    resume.kind === 'onboarding' && getOnboardingProgress().complete;
  const tone: 'accent' | 'success' = isComplete ? 'success' : 'accent';

  // Onboarding "resume" routes through the host wizard (onResume); a concrete
  // session routes through navigation (onResumeSession + path).
  const sessionPath = resume.kind !== 'onboarding' ? resume.path : undefined;
  const canResumeOnboarding =
    resume.kind === 'onboarding' && !isComplete && !!onResume;
  const canContinueSession = !!sessionPath && !!onResumeSession;

  const badgeText = isComplete
    ? "You're ready"
    : resume.kind === 'onboarding'
      ? 'Pick up where you left off'
      : 'Resume where you left off';

  // For the mid-onboarding nudge keep the original step-progress copy; otherwise
  // use the unified candidate's detail line.
  const onboardingStep = Math.min(getOnboardingProgress().step, ONBOARDING_TOTAL_STEPS);
  const body =
    resume.kind === 'onboarding' && !isComplete
      ? `You got to step ${onboardingStep} of ${ONBOARDING_TOTAL_STEPS} in setup. Finish connecting a local model and your sources to unlock grounded drills.`
      : isComplete
        ? 'Setup is complete — your local model and sources are wired up. Jump straight into today’s plan below.'
        : (resume.detail ?? resume.label);

  return (
    <Surface
      tone="study"
      density="compact"
      status={tone}
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
            <StatusBadge tone={tone}>{badgeText}</StatusBadge>
            <p className="muted-copy qv-mt-1 qv-m-0">{body}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
          {canResumeOnboarding && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                handleDismiss();
                onResume?.();
              }}
            >
              Resume setup
            </button>
          )}
          {canContinueSession && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                handleDismiss();
                onResumeSession?.(sessionPath as string);
              }}
            >
              <PlayCircle size={16} aria-hidden="true" style={{ marginRight: 'var(--space-1)' }} />
              {resume.domain === 'lsat' ? 'Continue' : 'Open'}
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
