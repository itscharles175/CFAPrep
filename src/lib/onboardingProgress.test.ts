import { beforeEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_COMPLETE_STEP,
  ONBOARDING_STEP_KEY,
  clearResumePromptDismissal,
  dismissResumePrompt,
  getOnboardingProgress,
  isResumePromptDismissed,
  markOnboardingComplete,
  setOnboardingStep,
} from './onboardingProgress';

describe('onboardingProgress', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports a brand-new user as step 0, not resumable, not complete', () => {
    expect(getOnboardingProgress()).toEqual({ step: 0, complete: false, resumable: false });
  });

  it('treats reaching step 1 as not resumable (just saw the dialog)', () => {
    setOnboardingStep(1);
    expect(getOnboardingProgress()).toMatchObject({ step: 1, resumable: false, complete: false });
  });

  it('treats reaching step 2+ as resumable', () => {
    setOnboardingStep(2);
    expect(getOnboardingProgress()).toMatchObject({ step: 2, resumable: true, complete: false });
    setOnboardingStep(3);
    expect(getOnboardingProgress()).toMatchObject({ step: 3, resumable: true });
  });

  it('is monotonic — recording an earlier step never rewinds the high-water mark', () => {
    setOnboardingStep(3);
    setOnboardingStep(1);
    expect(getOnboardingProgress().step).toBe(3);
  });

  it('force overwrites the stored step unconditionally', () => {
    setOnboardingStep(3);
    setOnboardingStep(1, { force: true });
    expect(getOnboardingProgress().step).toBe(1);
  });

  it('markOnboardingComplete sets the completion sentinel and flips complete/resumable', () => {
    setOnboardingStep(2);
    markOnboardingComplete();
    const progress = getOnboardingProgress();
    expect(progress.step).toBe(ONBOARDING_COMPLETE_STEP);
    expect(progress.complete).toBe(true);
    expect(progress.resumable).toBe(false);
    expect(localStorage.getItem(ONBOARDING_STEP_KEY)).toBe(String(ONBOARDING_COMPLETE_STEP));
  });

  it('round-trips the resume-prompt dismissal flag', () => {
    expect(isResumePromptDismissed()).toBe(false);
    dismissResumePrompt();
    expect(isResumePromptDismissed()).toBe(true);
    clearResumePromptDismissal();
    expect(isResumePromptDismissed()).toBe(false);
  });

  it('ignores corrupt stored values', () => {
    localStorage.setItem(ONBOARDING_STEP_KEY, 'not-a-number');
    expect(getOnboardingProgress().step).toBe(0);
  });
});
