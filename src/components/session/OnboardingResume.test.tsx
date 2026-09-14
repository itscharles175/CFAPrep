import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingResume } from './OnboardingResume';
import {
  markOnboardingComplete,
  setOnboardingStep,
  isResumePromptDismissed,
} from '../../lib/onboardingProgress';
import { setResume } from '../../domains/lsat/lib/resume';

describe('OnboardingResume', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders nothing for a brand-new user (step 0)', () => {
    const { container } = render(<OnboardingResume />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the resume prompt and a Resume button when mid-onboarding', async () => {
    setOnboardingStep(2);
    const onResume = vi.fn();
    render(<OnboardingResume onResume={onResume} />);
    expect(screen.getByText(/pick up where you left off/i)).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 3/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /resume setup/i }));
    expect(onResume).toHaveBeenCalledOnce();
    // Resuming also dismisses so it doesn't double-nag.
    expect(isResumePromptDismissed()).toBe(true);
  });

  it('shows the "you\'re ready" state when onboarding is complete', () => {
    markOnboardingComplete();
    render(<OnboardingResume />);
    expect(screen.getByText(/you're ready/i)).toBeInTheDocument();
    // No resume button in the complete state.
    expect(screen.queryByRole('button', { name: /resume setup/i })).not.toBeInTheDocument();
  });

  it('dismiss button hides the prompt and persists the dismissal', async () => {
    setOnboardingStep(3);
    const { container } = render(<OnboardingResume onResume={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss onboarding prompt/i }));
    expect(container).toBeEmptyDOMElement();
    expect(isResumePromptDismissed()).toBe(true);
  });

  it('stays hidden when previously dismissed', () => {
    setOnboardingStep(2);
    localStorage.setItem('qv-onboarding-resume-dismissed', '1');
    const { container } = render(<OnboardingResume />);
    expect(container).toBeEmptyDOMElement();
  });

  it('continues an LSAT resume through the app-root LSAT route', async () => {
    const onResumeSession = vi.fn();
    setResume({
      kind: 'section',
      label: 'PT 73 · LR Section 1',
      path: '/take/73',
      updatedAt: '2026-09-14T12:00:00.000Z',
    });

    render(<OnboardingResume onResumeSession={onResumeSession} />);

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onResumeSession).toHaveBeenCalledWith('/lsat/take/73');
  });
});
