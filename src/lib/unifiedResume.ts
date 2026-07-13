// ---------------------------------------------------------------------------
// UX-3 — unified onboarding / resume across domains.
//
// StudyVault is two study planes wearing one shell: the host (CFA/Quant/Excel,
// React/Dexie) and the LSAT domain (its own prefs + sidecar). Before this module
// each plane tracked onboarding and "resume where you left off" independently, so
// a user who finished (or dismissed) onboarding on the host could still get the
// LSAT "First Light" wizard on their next hop into /lsat, and the resume nudge on
// Today only ever knew about the host's own onboarding step — never the most
// recent LSAT section the user actually left mid-flight.
//
// This module is the single arbiter that fixes both:
//
//   • DISMISS PARITY — a synchronous, cross-domain "onboarding dismissed" flag
//     (`qv-onboarding-dismissed-unified`). When EITHER wizard is finished or
//     skipped it is set, and BOTH wizards consult it on the next open. The LSAT
//     wizard additionally mirrors it into its own `lsatlab.onboardingDone` key so
//     existing LSAT-only readers keep working. Net effect: dismiss once, anywhere,
//     and neither wizard re-appears.
//
//   • RECENCY-WINNER RESUME — `getUnifiedResume()` merges three signals and picks
//     the most recent:
//        1. host onboarding progress (UB7 `onboardingProgress.ts`) — surfaces the
//           "resume setup" / "you're ready" onboarding nudge,
//        2. the LSAT explicit resume pointer (`@lsat/lib/resume` `getResume()`) —
//           a concrete in-progress section/exam/drill with a route + `updatedAt`,
//        3. the host's most-recent study activity, read from the DATA-4a
//           cross-domain bridge attempts (`createdAt`) — the host has no explicit
//           resume pointer, so its latest attempt timestamp stands in as "the last
//           place you were studying on the host plane".
//
// Everything here is synchronous + pure where it can be (onboarding + LSAT resume
// are localStorage; the host activity probe is async via the storage driver) and
// fully degrading: a missing key, malformed value, or absent driver bridge yields
// a clean null contribution rather than throwing. Nothing here mutates host or
// LSAT study data — it only reads, plus owns the one shared dismiss flag.
// ---------------------------------------------------------------------------

import {
  ONBOARDING_TOTAL_STEPS,
  getOnboardingProgress,
} from './onboardingProgress';
import { getResume } from '../domains/lsat/lib/resume';
import { getStorage } from './storage';

/**
 * Synchronous, cross-domain "onboarding dismissed" flag. Distinct from the host's
 * async `settings['onboarding-dismissed']` row (which Dashboard reads to decide
 * whether to auto-open the host wizard) and from the per-state resume-prompt
 * dismissal (`qv-onboarding-resume-dismissed`): this one means "the user has
 * settled onboarding on SOME plane, don't pop a wizard at them again". It is in
 * localStorage so the LSAT wizard — which decides `open` synchronously at first
 * paint — can consult it without an async round-trip.
 */
export const UNIFIED_ONBOARDING_DISMISSED_KEY = 'qv-onboarding-dismissed-unified';

/** Which plane a unified-resume winner came from. */
export type ResumeDomain = 'host' | 'lsat';

/** What kind of thing the unified resume points the user back to. */
export type UnifiedResumeKind =
  /** Finish / "you're ready" onboarding nudge (host onboarding progress). */
  | 'onboarding'
  /** A concrete in-progress LSAT section / exam / drill / blind-review. */
  | 'lsat-session'
  /** The host plane's most-recent study activity (latest attempt). */
  | 'host-activity';

/**
 * The single most-recent resumable thing across both planes, or null when there
 * is nothing worth surfacing. `at` is the ISO timestamp used to pick the winner;
 * `path` is the in-app route to navigate to (absent for the onboarding nudge,
 * which the host owns via its wizard rather than a route).
 */
export interface UnifiedResume {
  kind: UnifiedResumeKind;
  domain: ResumeDomain;
  /** Short headline for the prompt (e.g. "Resume LSAT section"). */
  label: string;
  /** Optional secondary line (e.g. the section title / step progress). */
  detail?: string;
  /** ISO 8601 timestamp the winner was last touched; the recency key. */
  at: string;
  /** In-app route to resume at, when the winner is a concrete location. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Cross-domain dismiss flag — synced BOTH ways by the two wizards.
// ---------------------------------------------------------------------------

/**
 * Whether onboarding has been settled (finished or skipped) on any plane.
 * Synchronous + best-effort: a missing localStorage (SSR / private mode) reads as
 * "not dismissed" so onboarding can still run.
 */
export function isUnifiedOnboardingDismissed(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(UNIFIED_ONBOARDING_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Record that onboarding has been settled on some plane. Idempotent. Called by
 * BOTH the host wizard (on finish/skip) and the LSAT wizard (on finish/skip), so
 * the other plane's wizard never re-appears.
 */
export function setUnifiedOnboardingDismissed(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(UNIFIED_ONBOARDING_DISMISSED_KEY, '1');
  } catch {
    /* private-mode / quota — the flag just won't persist */
  }
}

/** Clear the cross-domain dismissal (used by resets / tests). */
export function clearUnifiedOnboardingDismissed(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(UNIFIED_ONBOARDING_DISMISSED_KEY);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Per-source candidates — each returns at most one candidate, or null.
// ---------------------------------------------------------------------------

/**
 * Onboarding candidate (host UB7 progress). Surfaces the same two states the
 * standalone resume prompt did — `resumable` (started, bailed) and `complete`
 * ("you're ready") — but folded into the unified recency race. Brand-new users
 * (step 0) contribute nothing. Onboarding progress carries no timestamp, so it is
 * intentionally given NO `at` here and is only chosen as a last resort by
 * {@link getUnifiedResume} when no timestamped study activity exists.
 */
export function onboardingResumeCandidate(): Omit<UnifiedResume, 'at'> | null {
  const { resumable, complete, step } = getOnboardingProgress();
  if (resumable) {
    const reached = Math.min(step, ONBOARDING_TOTAL_STEPS);
    return {
      kind: 'onboarding',
      domain: 'host',
      label: 'Finish setting up StudyVault',
      detail: `You reached step ${reached} of ${ONBOARDING_TOTAL_STEPS} in setup.`,
    };
  }
  if (complete) {
    return {
      kind: 'onboarding',
      domain: 'host',
      label: "You're all set",
      detail: 'Setup is complete — jump into today’s plan.',
    };
  }
  return null;
}

/**
 * LSAT explicit resume pointer (`@lsat/lib/resume`). A concrete in-progress
 * section / exam / drill / blind-review with a route and `updatedAt`. Fully
 * timestamped, so it competes directly in the recency race.
 */
export function lsatResumeCandidate(): UnifiedResume | null {
  let ptr: ReturnType<typeof getResume>;
  try {
    ptr = getResume();
  } catch {
    return null;
  }
  if (!ptr || !ptr.updatedAt) return null;
  const kindLabel =
    ptr.kind === 'exam'
      ? 'exam'
      : ptr.kind === 'blind-review'
        ? 'blind review'
        : ptr.kind === 'drill'
          ? 'drill'
          : 'section';
  return {
    kind: 'lsat-session',
    domain: 'lsat',
    label: `Resume LSAT ${kindLabel}`,
    detail: ptr.label,
    at: ptr.updatedAt,
    path: ptr.path,
  };
}

/**
 * Host most-recent study activity, via the DATA-4a cross-domain bridge attempts.
 * The host has no explicit resume pointer, so the latest attempt's `createdAt`
 * stands in as "where you were last studying on the host plane". Async + fully
 * degrading: an absent bridge (driver doesn't expose it) or a read failure yields
 * null. Returns the single newest attempt only.
 */
export async function hostActivityResumeCandidate(): Promise<UnifiedResume | null> {
  let bridge;
  try {
    bridge = getStorage().crossDomainBridge;
  } catch {
    return null;
  }
  if (!bridge) return null;
  try {
    const attempts = await bridge.attempts();
    let newestAt: string | null = null;
    for (const a of attempts) {
      if (a.createdAt && (newestAt == null || a.createdAt > newestAt)) {
        newestAt = a.createdAt;
      }
    }
    if (!newestAt) return null;
    return {
      kind: 'host-activity',
      domain: 'host',
      label: 'Back to your studies',
      detail: 'Pick up where you left off in your last session.',
      at: newestAt,
      // The host owns its own in-app routing (Today/Dashboard); navigating to "/"
      // returns to the host home rather than guessing a deep link.
      path: '/',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Arbiter — merge the candidates and pick the recency winner.
// ---------------------------------------------------------------------------

/** Compare two ISO timestamps; returns true when `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb)) return true;
  return ta > tb;
}

/**
 * The synchronous slice of the unified resume: the most-recent of the timestamped
 * candidates available without an async driver read (currently just the LSAT
 * resume pointer), falling back to the onboarding nudge when no timestamped study
 * activity exists. Use this at first paint to avoid an onboarding-flash; call
 * {@link getUnifiedResume} in an effect to fold in async host activity.
 */
export function getUnifiedResumeSync(): UnifiedResume | null {
  const lsat = lsatResumeCandidate();
  const onboarding = onboardingResumeCandidate();
  // A concrete, timestamped session always beats the (timestamp-less) onboarding
  // nudge — actively-in-progress study is more pressing than "finish setup".
  if (lsat) return lsat;
  if (onboarding) return { ...onboarding, at: '' };
  return null;
}

/**
 * The full unified resume: the single most-recent resumable thing across BOTH
 * planes. Folds the async host-activity probe into the recency race against the
 * LSAT resume pointer, and falls back to the onboarding nudge only when there is
 * no timestamped study activity on either plane.
 *
 * Fully degrading: any source that fails simply doesn't contribute. Returns null
 * when there is nothing worth surfacing (brand-new user, no sessions, no driver).
 */
export async function getUnifiedResume(): Promise<UnifiedResume | null> {
  const lsat = lsatResumeCandidate();
  const host = await hostActivityResumeCandidate();
  const onboarding = onboardingResumeCandidate();

  // Race the two timestamped study candidates by recency.
  let winner: UnifiedResume | null = null;
  if (lsat && host) {
    winner = isNewer(host.at, lsat.at) ? host : lsat;
  } else {
    winner = lsat ?? host;
  }
  if (winner) return winner;

  // No active study session anywhere — fall back to the onboarding nudge.
  if (onboarding) return { ...onboarding, at: '' };
  return null;
}
