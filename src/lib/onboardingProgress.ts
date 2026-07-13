// ---------------------------------------------------------------------------
// UB7 — onboarding-resume state (host).
//
// The onboarding wizard (src/components/Onboarding/OnboardingWizard.tsx) is a
// 3-step dialog whose `step` lives in transient component state and resets to 1
// every time it closes. That means a user who dismisses partway through loses
// their place. This helper persists the furthest step a user reached to
// localStorage so Today can offer a low-key "resume where you left off" prompt,
// plus a "you're ready" CTA once onboarding has been completed.
//
// Why localStorage (not the storage driver): the wizard's *dismissed* flag lives
// in the async storage driver (Dexie/SurrealDB) and Today already reads it via
// the same mechanism Dashboard writes it with. Onboarding progress, by contrast,
// must be readable synchronously at first paint so the resume prompt never
// flashes in late — the same bootstrap-critical pattern the theme + storage
// preference use. This file is additively owned by UB7; it does not modify the
// wizard or Dashboard, both of which already work without it.
// ---------------------------------------------------------------------------

/** Total number of onboarding steps the wizard walks through. */
export const ONBOARDING_TOTAL_STEPS = 3;

/** Sentinel step value meaning "onboarding finished". */
export const ONBOARDING_COMPLETE_STEP = ONBOARDING_TOTAL_STEPS + 1;

/** localStorage key holding the furthest onboarding step the user reached. */
export const ONBOARDING_STEP_KEY = 'qv-onboarding-step';

/** localStorage key holding a per-key dismissal of the resume prompt. */
export const ONBOARDING_RESUME_DISMISSED_KEY = 'qv-onboarding-resume-dismissed';

export interface OnboardingProgress {
  /**
   * The furthest step reached. `1..ONBOARDING_TOTAL_STEPS` while in progress,
   * `ONBOARDING_COMPLETE_STEP` once finished, and `0` for a brand-new user who
   * has not interacted with onboarding at all.
   */
  step: number;
  /** True once the user has walked through to the end. */
  complete: boolean;
  /** True when the user is mid-way (between step 2 and the end, exclusive). */
  resumable: boolean;
}

function readNumber(key: string): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Read the persisted onboarding progress. Pure + synchronous so it can run
 * during the first render without an effect-driven flash.
 */
export function getOnboardingProgress(): OnboardingProgress {
  const step = readNumber(ONBOARDING_STEP_KEY);
  const complete = step >= ONBOARDING_COMPLETE_STEP;
  // "Resumable" means the user started but did not finish: they are past the
  // welcome step (step 1) yet have not reached completion. Step 1 alone is just
  // "saw the dialog" — not worth nagging about — so the threshold is step >= 2.
  const resumable = !complete && step >= 2;
  return { step, complete, resumable };
}

/**
 * Persist the furthest step reached. Monotonic by default — recording an
 * earlier step never rewinds the stored high-water mark, so re-opening the
 * wizard at step 1 doesn't erase a previously-completed run. Pass `force` to
 * overwrite unconditionally (used by resets/tests).
 */
export function setOnboardingStep(step: number, { force = false }: { force?: boolean } = {}): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const next = Math.max(0, Math.floor(step));
    if (!force) {
      const current = readNumber(ONBOARDING_STEP_KEY);
      if (next <= current) return;
    }
    localStorage.setItem(ONBOARDING_STEP_KEY, String(next));
  } catch {
    /* private-mode / quota — progress just won't persist */
  }
}

/** Mark onboarding as finished (sets the completion sentinel). */
export function markOnboardingComplete(): void {
  setOnboardingStep(ONBOARDING_COMPLETE_STEP, { force: true });
}

/** Whether the resume prompt has been dismissed for the current state. */
export function isResumePromptDismissed(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(ONBOARDING_RESUME_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Hide the resume prompt until onboarding progress changes again. */
export function dismissResumePrompt(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ONBOARDING_RESUME_DISMISSED_KEY, '1');
  } catch {
    /* best-effort */
  }
}

/** Re-show the resume prompt (clears the per-state dismissal). */
export function clearResumePromptDismissal(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(ONBOARDING_RESUME_DISMISSED_KEY);
  } catch {
    /* best-effort */
  }
}
