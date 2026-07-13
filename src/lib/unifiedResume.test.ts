import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Hoisted mock state. The host-activity source reads the cross-domain bridge
// off the active storage driver; we stub `getStorage().crossDomainBridge`
// (vi.mock factories run before imports, so the mutable attempt list lives in a
// hoisted block). The LSAT resume pointer + onboarding progress use real
// localStorage (jsdom), so those sources are exercised end-to-end.
// --------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  return {
    attempts: [] as Array<{ createdAt?: string }>,
    bridgePresent: true,
  };
});

vi.mock('./storage', () => ({
  getStorage: () => ({
    crossDomainBridge: mocks.bridgePresent
      ? {
          attempts: async () => mocks.attempts,
        }
      : undefined,
  }),
}));

import {
  UNIFIED_ONBOARDING_DISMISSED_KEY,
  clearUnifiedOnboardingDismissed,
  getUnifiedResume,
  getUnifiedResumeSync,
  hostActivityResumeCandidate,
  isUnifiedOnboardingDismissed,
  lsatResumeCandidate,
  onboardingResumeCandidate,
  setUnifiedOnboardingDismissed,
} from './unifiedResume';
import {
  markOnboardingComplete,
  setOnboardingStep,
} from './onboardingProgress';
import { setResume } from '../domains/lsat/lib/resume';

describe('unifiedResume — cross-domain dismiss flag', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.attempts = [];
    mocks.bridgePresent = true;
  });

  it('round-trips the unified dismiss flag (set / read / clear)', () => {
    expect(isUnifiedOnboardingDismissed()).toBe(false);
    setUnifiedOnboardingDismissed();
    expect(isUnifiedOnboardingDismissed()).toBe(true);
    expect(localStorage.getItem(UNIFIED_ONBOARDING_DISMISSED_KEY)).toBe('1');
    clearUnifiedOnboardingDismissed();
    expect(isUnifiedOnboardingDismissed()).toBe(false);
  });

  it('set is idempotent', () => {
    setUnifiedOnboardingDismissed();
    setUnifiedOnboardingDismissed();
    expect(isUnifiedOnboardingDismissed()).toBe(true);
  });
});

describe('unifiedResume — per-source candidates', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.attempts = [];
    mocks.bridgePresent = true;
  });

  it('onboarding candidate is null for a brand-new user', () => {
    expect(onboardingResumeCandidate()).toBeNull();
  });

  it('onboarding candidate is the resume nudge when mid-onboarding', () => {
    setOnboardingStep(2);
    const c = onboardingResumeCandidate();
    expect(c?.kind).toBe('onboarding');
    expect(c?.domain).toBe('host');
    expect(c?.detail).toMatch(/step 2 of 3/i);
  });

  it('onboarding candidate is the "you\'re all set" state when complete', () => {
    markOnboardingComplete();
    const c = onboardingResumeCandidate();
    expect(c?.kind).toBe('onboarding');
    expect(c?.label).toMatch(/all set/i);
  });

  it('LSAT candidate reflects the stored resume pointer with its route + timestamp', () => {
    setResume({
      kind: 'section',
      label: 'PT 73 · LR Section 1',
      path: '/take/73',
      updatedAt: '2026-06-15T10:00:00.000Z',
    });
    const c = lsatResumeCandidate();
    expect(c).toMatchObject({
      kind: 'lsat-session',
      domain: 'lsat',
      path: '/take/73',
      at: '2026-06-15T10:00:00.000Z',
    });
    expect(c?.label).toMatch(/resume lsat section/i);
    expect(c?.detail).toBe('PT 73 · LR Section 1');
  });

  it('LSAT candidate is null when there is no resume pointer', () => {
    expect(lsatResumeCandidate()).toBeNull();
  });

  it('host-activity candidate picks the newest attempt timestamp', async () => {
    mocks.attempts = [
      { createdAt: '2026-06-10T09:00:00.000Z' },
      { createdAt: '2026-06-14T18:30:00.000Z' },
      { createdAt: '2026-06-12T12:00:00.000Z' },
    ];
    const c = await hostActivityResumeCandidate();
    expect(c).toMatchObject({ kind: 'host-activity', domain: 'host', at: '2026-06-14T18:30:00.000Z' });
  });

  it('host-activity candidate is null with no attempts or no bridge', async () => {
    expect(await hostActivityResumeCandidate()).toBeNull();
    mocks.bridgePresent = false;
    expect(await hostActivityResumeCandidate()).toBeNull();
  });
});

describe('unifiedResume — recency arbiter', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.attempts = [];
    mocks.bridgePresent = true;
  });

  it('returns null when nothing is resumable', async () => {
    expect(getUnifiedResumeSync()).toBeNull();
    expect(await getUnifiedResume()).toBeNull();
  });

  it('picks the LSAT session over the onboarding nudge (active study beats setup)', () => {
    setOnboardingStep(2);
    setResume({ kind: 'drill', label: 'Daily 10', path: '/drills', updatedAt: '2026-06-15T08:00:00.000Z' });
    const r = getUnifiedResumeSync();
    expect(r?.kind).toBe('lsat-session');
    expect(r?.domain).toBe('lsat');
  });

  it('falls back to the onboarding nudge when no timestamped session exists', () => {
    setOnboardingStep(2);
    const r = getUnifiedResumeSync();
    expect(r?.kind).toBe('onboarding');
    expect(r?.at).toBe('');
  });

  it('picks the most-recent across host activity and LSAT (host newer wins)', async () => {
    setResume({ kind: 'section', label: 'PT 80 · S2', path: '/take/80', updatedAt: '2026-06-10T08:00:00.000Z' });
    mocks.attempts = [{ createdAt: '2026-06-14T08:00:00.000Z' }];
    const r = await getUnifiedResume();
    expect(r?.domain).toBe('host');
    expect(r?.kind).toBe('host-activity');
    expect(r?.at).toBe('2026-06-14T08:00:00.000Z');
  });

  it('picks the most-recent across host activity and LSAT (LSAT newer wins)', async () => {
    setResume({ kind: 'exam', label: 'PT 80 full', path: '/exam/80', updatedAt: '2026-06-16T08:00:00.000Z' });
    mocks.attempts = [{ createdAt: '2026-06-14T08:00:00.000Z' }];
    const r = await getUnifiedResume();
    expect(r?.domain).toBe('lsat');
    expect(r?.kind).toBe('lsat-session');
    expect(r?.path).toBe('/exam/80');
  });

  it('prefers any timestamped session over onboarding in the async path', async () => {
    markOnboardingComplete();
    mocks.attempts = [{ createdAt: '2026-06-14T08:00:00.000Z' }];
    const r = await getUnifiedResume();
    expect(r?.kind).toBe('host-activity');
  });
});
