import type { StudySession, StudySessionDomain } from './learningTypes';

export const FOCUS_SESSION_STORAGE_KEY = 'studyvault.focus-session.v1';

export type FocusSessionStatus = 'running' | 'paused' | 'saving' | 'save-error';

export interface FocusSession {
  version: 1;
  sessionId: string;
  status: FocusSessionStatus;
  domain: StudySessionDomain;
  topic: string;
  startedAt: string;
  segmentStartedAtMs: number | null;
  accumulatedMs: number;
  questionsAnswered: number;
  score: number;
  updatedAt: string;
  saveError: string | null;
}

export interface FocusSessionActivity {
  domain?: StudySessionDomain;
  topic?: string;
  questionsAnswered?: number;
  score?: number;
}

type FocusSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function validDomain(value: unknown): value is StudySessionDomain {
  return value === 'cfa' || value === 'quant' || value === 'excel' || value === 'lsat';
}

function makeSessionId(nowMs: number): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // A deterministic-enough local fallback is sufficient for this UI checkpoint.
  }
  return `focus-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createFocusSession(
  activity: FocusSessionActivity = {},
  nowMs = Date.now(),
): FocusSession {
  return {
    version: 1,
    sessionId: makeSessionId(nowMs),
    status: 'running',
    domain: activity.domain ?? 'cfa',
    topic: activity.topic?.trim() || `${activity.domain ?? 'cfa'}:today`,
    startedAt: new Date(nowMs).toISOString(),
    segmentStartedAtMs: nowMs,
    accumulatedMs: 0,
    questionsAnswered: Math.floor(finiteNonNegative(activity.questionsAnswered)),
    score: finiteNonNegative(activity.score),
    updatedAt: new Date(nowMs).toISOString(),
    saveError: null,
  };
}

export function elapsedFocusMs(session: FocusSession, nowMs = Date.now()): number {
  const activeSegment =
    session.status === 'running' && session.segmentStartedAtMs != null
      ? Math.max(0, nowMs - session.segmentStartedAtMs)
      : 0;
  return session.accumulatedMs + activeSegment;
}

export function checkpointFocusSession(session: FocusSession, nowMs = Date.now()): FocusSession {
  return { ...session, updatedAt: new Date(nowMs).toISOString() };
}

export function pauseFocusSession(session: FocusSession, nowMs = Date.now()): FocusSession {
  if (session.status !== 'running' || session.segmentStartedAtMs == null) return session;
  return {
    ...session,
    status: 'paused',
    accumulatedMs: elapsedFocusMs(session, nowMs),
    segmentStartedAtMs: null,
    updatedAt: new Date(nowMs).toISOString(),
    saveError: null,
  };
}

export function resumeFocusSession(session: FocusSession, nowMs = Date.now()): FocusSession {
  if (session.status === 'running' || session.status === 'saving') return session;
  return {
    ...session,
    status: 'running',
    segmentStartedAtMs: nowMs,
    updatedAt: new Date(nowMs).toISOString(),
    saveError: null,
  };
}

export function updateFocusSessionActivity(
  session: FocusSession,
  activity: FocusSessionActivity,
  nowMs = Date.now(),
): FocusSession {
  return {
    ...session,
    domain: activity.domain ?? session.domain,
    topic: activity.topic?.trim() || session.topic,
    questionsAnswered:
      activity.questionsAnswered == null
        ? session.questionsAnswered
        : Math.floor(finiteNonNegative(activity.questionsAnswered)),
    score: activity.score == null ? session.score : finiteNonNegative(activity.score),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function toStudySession(session: FocusSession, nowMs = Date.now()): Omit<StudySession, 'id'> {
  const elapsedSeconds = Math.floor(elapsedFocusMs(session, nowMs) / 1000);
  return {
    domain: session.domain,
    topic: session.topic,
    mode: 'focus-timer',
    startedAt: session.startedAt,
    endedAt: new Date(nowMs).toISOString(),
    elapsedSeconds,
    questionsAnswered: session.questionsAnswered,
    score: session.score,
  };
}

export function persistFocusSession(session: FocusSession, storage?: FocusSessionStorage | null): boolean {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    if (!target) return false;
    target.setItem(FOCUS_SESSION_STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearFocusSession(storage?: FocusSessionStorage | null): void {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    target?.removeItem(FOCUS_SESSION_STORAGE_KEY);
  } catch {
    // The in-memory React state can still be cleared in locked-down storage.
  }
}

export function loadFocusSession(
  storage?: FocusSessionStorage | null,
  nowMs = Date.now(),
): FocusSession | null {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    const raw = target?.getItem(FOCUS_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<FocusSession>;
    if (
      value.version !== 1 ||
      typeof value.sessionId !== 'string' ||
      !validDomain(value.domain) ||
      typeof value.topic !== 'string' ||
      typeof value.startedAt !== 'string' ||
      typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt))
    ) return null;

    const persistedStatus = value.status;
    const status: FocusSessionStatus =
      persistedStatus === 'save-error' ? 'save-error' : persistedStatus === 'paused' ? 'paused' : 'paused';
    const checkpointMs = Math.min(nowMs, Date.parse(value.updatedAt));
    const segmentStartedAtMs = finiteNonNegative(value.segmentStartedAtMs);
    const accumulatedMs = finiteNonNegative(value.accumulatedMs) +
      (persistedStatus === 'running' && segmentStartedAtMs > 0
        ? Math.max(0, checkpointMs - segmentStartedAtMs)
        : 0);

    return {
      version: 1,
      sessionId: value.sessionId,
      status,
      domain: value.domain,
      topic: value.topic,
      startedAt: value.startedAt,
      segmentStartedAtMs: null,
      accumulatedMs,
      questionsAnswered: Math.floor(finiteNonNegative(value.questionsAnswered)),
      score: finiteNonNegative(value.score),
      updatedAt: new Date(nowMs).toISOString(),
      saveError: status === 'save-error' && typeof value.saveError === 'string' ? value.saveError : null,
    };
  } catch {
    return null;
  }
}
