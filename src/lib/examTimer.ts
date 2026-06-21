/**
 * examTimer.ts — GAP-CLOCK-1: a wall-clock-anchored, throttle/sleep-resistant
 * countdown timer with crash-resume.
 *
 * WHY a dedicated module: a naive exam timer that does `remaining -= 1` on a
 * `setInterval(…, 1000)` drifts badly. Background tabs are throttled to ~1 tick
 * per minute (or frozen entirely), the machine can sleep, and a crash/reload
 * loses the count outright. For a timed exam that is unacceptable — the wall
 * clock kept moving even though the interval didn't fire.
 *
 * The fix: anchor to an ABSOLUTE deadline (`Date.now()` + duration). Every tick
 * — and crucially every `visibilitychange` back to visible — we recompute
 * `remaining = deadline - Date.now()`. The interval is then only a *render*
 * heartbeat, not the source of truth, so throttling/sleep can never make the
 * exam run long. We persist `{ deadlineMs, ... }` to storage so a reload or
 * crash mid-exam resumes against the same wall-clock deadline.
 *
 * Pausing is supported by storing the absolute pause instant and, on resume,
 * pushing the deadline forward by the elapsed pause duration (so the *remaining*
 * time is preserved across a pause even though it is deadline-anchored).
 *
 * Fully offline, no React, no network. Storage is sessionStorage by default
 * (cleared when the tab/window closes — the natural lifetime of one exam sitting)
 * with a graceful in-memory fallback when Web Storage is unavailable (jsdom
 * without it, privacy modes, SSR).
 */

/** Serializable timer snapshot persisted to survive reload/crash. */
export interface ExamTimerState {
  /** Stable id so multiple concurrent timers don't collide in storage. */
  id: string;
  /** Absolute wall-clock instant (ms epoch) the timer expires at. */
  deadlineMs: number;
  /** Total configured duration in ms (for progress + restart). */
  durationMs: number;
  /** When paused: the absolute instant the pause began; null when running. */
  pausedAtMs: number | null;
  /** Schema/version marker so a future shape change can be detected & dropped. */
  v: 1;
}

export interface ExamTimerOptions {
  /** Unique id for this exam sitting (used as the storage key suffix). */
  id: string;
  /** Total duration in milliseconds. */
  durationMs: number;
  /**
   * Storage backend. Defaults to sessionStorage (per-sitting lifetime). Pass
   * localStorage for a timer that should survive a full tab close, or omit in
   * environments without Web Storage to use the in-memory fallback.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Render-heartbeat cadence in ms. Default 250ms (sub-second smoothness). */
  tickMs?: number;
  /** Start paused (timer created but not counting). Default false. */
  startPaused?: boolean;
}

export interface ExamTimerTick {
  /** Milliseconds left, clamped at 0. */
  remainingMs: number;
  /** Whole seconds left, clamped at 0 (what UIs usually render). */
  remainingSeconds: number;
  /** Whether the deadline has passed. */
  expired: boolean;
  /** Whether currently paused. */
  paused: boolean;
  /** 0..1 fraction elapsed (for progress rails). */
  fractionElapsed: number;
}

const STORAGE_PREFIX = 'quantvault:exam-timer:';

/** Minimal in-memory store used when Web Storage is unavailable. */
function createMemoryStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Resolve the storage backend. Explicit `null`/undefined falls back to
 * sessionStorage, then to an in-memory shim if even that throws (privacy mode).
 */
function resolveStorage(
  explicit: ExamTimerOptions['storage'],
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  if (explicit) return explicit;
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      // Touch it to surface SecurityError in locked-down contexts early.
      const probe = `${STORAGE_PREFIX}__probe__`;
      window.sessionStorage.setItem(probe, '1');
      window.sessionStorage.removeItem(probe);
      return window.sessionStorage;
    }
  } catch {
    // fall through to memory
  }
  return createMemoryStore();
}

/** Read a persisted state by id, tolerating absent/corrupt entries. */
export function loadExamTimerState(
  id: string,
  storage?: ExamTimerOptions['storage'],
): ExamTimerState | null {
  const store = resolveStorage(storage);
  try {
    const raw = store.getItem(STORAGE_PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExamTimerState>;
    if (
      !parsed ||
      parsed.v !== 1 ||
      parsed.id !== id ||
      typeof parsed.deadlineMs !== 'number' ||
      typeof parsed.durationMs !== 'number'
    ) {
      return null;
    }
    return {
      id,
      deadlineMs: parsed.deadlineMs,
      durationMs: parsed.durationMs,
      pausedAtMs: typeof parsed.pausedAtMs === 'number' ? parsed.pausedAtMs : null,
      v: 1,
    };
  } catch {
    return null;
  }
}

/** Remove any persisted state for an id (call when the exam is submitted/abandoned). */
export function clearExamTimerState(id: string, storage?: ExamTimerOptions['storage']): void {
  try {
    resolveStorage(storage).removeItem(STORAGE_PREFIX + id);
  } catch {
    // best-effort
  }
}

/**
 * A deadline-anchored exam timer. Construction either resumes an existing
 * persisted state for the id (crash-resume) or creates a fresh one. Drive the UI
 * by passing `onTick`; call `dispose()` to stop and detach listeners.
 *
 * The class never mutates the page beyond an optional `visibilitychange`
 * listener it installs on `document` (so returning to a throttled/slept tab
 * reconciles instantly). It does not auto-submit; expiry is surfaced via the
 * tick payload (`expired: true`) and the optional `onExpire` callback, leaving
 * the policy decision (auto-finish vs. confirm) to the caller.
 */
export class ExamTimer {
  private state: ExamTimerState;
  private readonly store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onTick: ((tick: ExamTimerTick) => void) | null = null;
  private onExpire: (() => void) | null = null;
  private expiredFired = false;
  private readonly visibilityHandler: () => void;
  private disposed = false;

  constructor(options: ExamTimerOptions) {
    this.store = resolveStorage(options.storage);
    this.now = options.now ?? (() => Date.now());
    this.tickMs = Math.max(50, options.tickMs ?? 250);

    const existing = loadExamTimerState(options.id, this.store);
    if (existing && existing.durationMs === options.durationMs) {
      // Crash-resume: keep the original wall-clock deadline.
      this.state = existing;
    } else {
      const start = this.now();
      this.state = {
        id: options.id,
        deadlineMs: start + options.durationMs,
        durationMs: options.durationMs,
        pausedAtMs: options.startPaused ? start : null,
        v: 1,
      };
      this.persist();
    }

    // Reconcile the instant the tab becomes visible again — this is the moment
    // a throttled/slept timer would otherwise show a stale value.
    this.visibilityHandler = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.emit();
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /** Compute the current tick from the wall clock — the single source of truth. */
  read(): ExamTimerTick {
    const reference = this.state.pausedAtMs ?? this.now();
    const remainingMs = Math.max(0, this.state.deadlineMs - reference);
    const elapsedMs = Math.min(this.state.durationMs, this.state.durationMs - remainingMs);
    return {
      remainingMs,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      expired: remainingMs <= 0,
      paused: this.state.pausedAtMs !== null,
      fractionElapsed: this.state.durationMs > 0 ? elapsedMs / this.state.durationMs : 1,
    };
  }

  /** Subscribe to ticks + start the render heartbeat. Returns an unsubscribe fn. */
  start(handlers: { onTick?: (tick: ExamTimerTick) => void; onExpire?: () => void } = {}): () => void {
    this.onTick = handlers.onTick ?? null;
    this.onExpire = handlers.onExpire ?? null;
    this.emit(); // immediate sync so the UI never shows a blank/stale first frame
    if (this.intervalId === null && this.state.pausedAtMs === null) {
      this.intervalId = setInterval(() => this.emit(), this.tickMs);
    }
    return () => this.dispose();
  }

  /** Pause counting (freezes remaining time at the current wall-clock instant). */
  pause(): void {
    if (this.state.pausedAtMs !== null) return;
    this.state.pausedAtMs = this.now();
    this.stopInterval();
    this.persist();
    this.emit();
  }

  /**
   * Resume counting. The deadline is pushed forward by the paused duration so
   * the *remaining* time the user saw before pausing is exactly preserved.
   */
  resume(): void {
    if (this.state.pausedAtMs === null) return;
    const pausedDuration = this.now() - this.state.pausedAtMs;
    this.state.deadlineMs += Math.max(0, pausedDuration);
    this.state.pausedAtMs = null;
    this.persist();
    if (this.intervalId === null) {
      this.intervalId = setInterval(() => this.emit(), this.tickMs);
    }
    this.emit();
  }

  /** Reset to a fresh full-duration deadline (e.g. on restart). */
  reset(durationMs = this.state.durationMs): void {
    const start = this.now();
    this.state = {
      id: this.state.id,
      deadlineMs: start + durationMs,
      durationMs,
      pausedAtMs: null,
      v: 1,
    };
    this.expiredFired = false;
    this.persist();
    if (this.intervalId === null && !this.disposed) {
      this.intervalId = setInterval(() => this.emit(), this.tickMs);
    }
    this.emit();
  }

  /** Stop the heartbeat + detach listeners. Persisted state is left intact for resume. */
  dispose(): void {
    this.disposed = true;
    this.stopInterval();
    this.onTick = null;
    this.onExpire = null;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  private stopInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private persist(): void {
    try {
      this.store.setItem(STORAGE_PREFIX + this.state.id, JSON.stringify(this.state));
    } catch {
      // best-effort; the wall clock remains correct even without persistence.
    }
  }

  private emit(): void {
    const tick = this.read();
    this.onTick?.(tick);
    if (tick.expired && !this.expiredFired) {
      this.expiredFired = true;
      this.stopInterval(); // no point ticking past the deadline
      this.onExpire?.();
    }
  }
}

/** Convenience: format ms as `MM:SS` (or `H:MM:SS` past an hour). */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
