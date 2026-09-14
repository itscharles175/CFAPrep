import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StudySession } from '../../lib/learningTypes';
import { recordSession } from '../../lib/progressStore';
import {
  checkpointFocusSession,
  clearFocusSession,
  createFocusSession,
  elapsedFocusMs,
  loadFocusSession,
  pauseFocusSession,
  persistFocusSession,
  resumeFocusSession,
  toStudySession,
  updateFocusSessionActivity,
  type FocusSession,
  type FocusSessionActivity,
} from '../../lib/studySession';

type SessionRecorder = (session: Omit<StudySession, 'id'>) => Promise<unknown>;
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface StudySessionContextValue {
  session: FocusSession | null;
  elapsedSeconds: number;
  start: (activity?: FocusSessionActivity) => void;
  pause: () => void;
  updateActivity: (activity: FocusSessionActivity) => void;
  stopAndSave: () => Promise<boolean>;
  retrySave: () => Promise<boolean>;
  discard: () => void;
}

export interface StudySessionProviderProps {
  children: ReactNode;
  recorder?: SessionRecorder;
  storage?: SessionStorage | null;
  now?: () => number;
  checkpointIntervalMs?: number;
}

const StudySessionContext = createContext<StudySessionContextValue | null>(null);

export function StudySessionProvider({
  children,
  recorder = recordSession,
  storage,
  now = Date.now,
  checkpointIntervalMs = 5_000,
}: StudySessionProviderProps) {
  const [session, setSession] = useState<FocusSession | null>(() => loadFocusSession(storage, now()));
  const [clock, setClock] = useState(() => now());
  const saveInFlight = useRef(false);

  const commit = useCallback((next: FocusSession | null) => {
    setSession(next);
    if (next) persistFocusSession(next, storage);
    else clearFocusSession(storage);
  }, [storage]);

  useEffect(() => {
    if (session?.status !== 'running') return undefined;
    const tick = window.setInterval(() => setClock(now()), 1_000);
    return () => window.clearInterval(tick);
  }, [now, session?.status]);

  useEffect(() => {
    if (session?.status !== 'running') return undefined;
    const checkpoint = window.setInterval(() => {
      setSession((current) => {
        if (!current || current.status !== 'running') return current;
        const next = checkpointFocusSession(current, now());
        persistFocusSession(next, storage);
        return next;
      });
    }, Math.max(1_000, checkpointIntervalMs));
    return () => window.clearInterval(checkpoint);
  }, [checkpointIntervalMs, now, session?.status, storage]);

  // Ordinary focus sessions pause when the app is hidden/suspended. LSAT exam
  // timers are separate deadline-based clocks and never consume this provider.
  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      setSession((current) => {
        if (!current || current.status !== 'running') return current;
        const next = pauseFocusSession(current, now());
        persistFocusSession(next, storage);
        return next;
      });
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [now, storage]);

  const start = useCallback((activity: FocusSessionActivity = {}) => {
    const nowMs = now();
    setClock(nowMs);
    setSession((current) => {
      const next = current
        ? updateFocusSessionActivity(resumeFocusSession(current, nowMs), activity, nowMs)
        : createFocusSession(activity, nowMs);
      persistFocusSession(next, storage);
      return next;
    });
  }, [now, storage]);

  const pause = useCallback(() => {
    const nowMs = now();
    setClock(nowMs);
    setSession((current) => {
      if (!current) return current;
      const next = pauseFocusSession(current, nowMs);
      persistFocusSession(next, storage);
      return next;
    });
  }, [now, storage]);

  const updateActivity = useCallback((activity: FocusSessionActivity) => {
    setSession((current) => {
      if (!current) return current;
      const next = updateFocusSessionActivity(current, activity, now());
      persistFocusSession(next, storage);
      return next;
    });
  }, [now, storage]);

  const save = useCallback(async (candidate: FocusSession | null): Promise<boolean> => {
    if (!candidate || saveInFlight.current) return false;
    saveInFlight.current = true;
    const nowMs = now();
    const paused = candidate.status === 'running' ? pauseFocusSession(candidate, nowMs) : candidate;
    const payload = toStudySession(paused, nowMs);
    if (payload.elapsedSeconds <= 5) {
      commit(null);
      saveInFlight.current = false;
      return true;
    }
    const saving: FocusSession = { ...paused, status: 'saving', saveError: null, updatedAt: new Date(nowMs).toISOString() };
    commit(saving);
    try {
      await recorder(payload);
      commit(null);
      return true;
    } catch (error) {
      const failed: FocusSession = {
        ...saving,
        status: 'save-error',
        saveError: error instanceof Error ? error.message : 'The session could not be saved.',
        updatedAt: new Date(now()).toISOString(),
      };
      commit(failed);
      return false;
    } finally {
      saveInFlight.current = false;
    }
  }, [commit, now, recorder]);

  const stopAndSave = useCallback(() => save(session), [save, session]);
  const retrySave = useCallback(() => save(session), [save, session]);
  const discard = useCallback(() => commit(null), [commit]);

  const value = useMemo<StudySessionContextValue>(() => ({
    session,
    elapsedSeconds: session ? Math.floor(elapsedFocusMs(session, clock) / 1000) : 0,
    start,
    pause,
    updateActivity,
    stopAndSave,
    retrySave,
    discard,
  }), [clock, discard, pause, retrySave, session, start, stopAndSave, updateActivity]);

  return <StudySessionContext.Provider value={value}>{children}</StudySessionContext.Provider>;
}

export function useStudySession(): StudySessionContextValue {
  const value = useContext(StudySessionContext);
  if (!value) throw new Error('useStudySession must be used inside StudySessionProvider');
  return value;
}
