import { useSyncExternalStore } from "react";

/**
 * A2.1 / GAP-CLOCK-1 — the isolated 1-second exam clock.
 *
 * The timed section's `timeLeft` used to live as React state in `SectionRunner`'s
 * body, so every 1-second tick re-rendered the ENTIRE question/passage/choice
 * tree — most expensively, `HighlightableText` re-ran `splitParagraphBlocks` plus
 * per-paragraph boundary scans on every RC passage, ~2,100 wasted full
 * re-segmentations per 35-minute section.
 *
 * This module moves the countdown OUT of the render tree into a tiny external
 * store. The `setInterval` lives in the store; only components that explicitly
 * subscribe (`useClockTime`) re-render each second — the clock numerals, the pace
 * bar and the focus-mode hairline. `SectionRunner` itself does NOT subscribe to
 * the per-tick value, so the question tree renders only when the question/answer
 * state actually changes.
 *
 * Behaviour preserved, with one important hardening:
 *  - the clock is anchored to an absolute wall-clock deadline, so background-tab
 *    throttling, machine sleep, or a missed interval can never make a timed exam
 *    run long;
 *  - the interval is only a render heartbeat; on reaching 0 it stops, marks
 *    itself finished and fires the expiry callback exactly once (the old
 *    `onFinish(true)` auto-submit);
 *  - the LATEST value is always readable synchronously (`get()`), so the
 *    crash-safe draft flush + `beforeunload` capture the freshest remaining time
 *    without re-rendering;
 *  - untimed runs never start the interval and never auto-finish.
 */
interface ClockStoreOptions {
  /** Existing wall-clock deadline in ms epoch, used for crash/reload resume. */
  deadlineMs?: number | null;
  /** Injectable wall clock for deterministic tests. */
  now?: () => number;
}

export class ClockStore {
  private deadlineMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  /** Fired once when the clock reaches 0 (the timed auto-submit). */
  private onExpire: (() => void) | null = null;
  private readonly visibilityHandler: () => void;

  constructor(initial: number, options: ClockStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const initialSec = Math.max(0, Math.floor(initial));
    this.deadlineMs =
      typeof options.deadlineMs === "number"
        ? options.deadlineMs
        : this.now() + initialSec * 1000;
    this.visibilityHandler = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        this.emitFromDeadline();
      }
    };
  }

  /** Current remaining seconds. Safe to read synchronously at any time. */
  get = (): number => Math.max(0, Math.ceil((this.deadlineMs - this.now()) / 1000));

  /** Absolute wall-clock expiry instant. Persist this for crash/reload resume. */
  getDeadlineMs = (): number => this.deadlineMs;

  /** Subscribe to per-second changes. Returns an unsubscribe fn. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  /**
   * Start ticking once per second. The expiry callback is stored (not bound into
   * the interval closure) so the parent can update it across renders without the
   * timer being torn down — mirroring the old effect that deliberately excluded
   * `onFinish` from its deps so the interval was never reset mid-second.
   */
  start(onExpire: () => void) {
    this.onExpire = onExpire;
    if (this.intervalId != null || this.finished) return;
    this.installVisibilityListener();
    this.emitFromDeadline();
    if (this.finished) return;
    this.intervalId = setInterval(() => this.emitFromDeadline(), 1000);
  }

  /** Update the expiry callback without disturbing the running interval. */
  setOnExpire(onExpire: () => void) {
    this.onExpire = onExpire;
  }

  /** Stop ticking (idempotent). Does not fire the expiry callback. */
  stop() {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.removeVisibilityListener();
  }

  hasFinished = (): boolean => this.finished;

  private installVisibilityListener() {
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  private removeVisibilityListener() {
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  private emitFromDeadline() {
    if (this.finished) return;
    this.emit();
    if (this.get() <= 0) {
      this.stop();
      this.finished = true;
      this.emit();
      this.onExpire?.();
    }
  }
}

/**
 * Subscribe a component to the clock's per-second value. Components using this
 * are the ONLY ones that re-render each tick (the numerals, pace bar, hairline).
 */
export function useClockTime(store: ClockStore): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
