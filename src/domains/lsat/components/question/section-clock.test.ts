import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockStore } from "./section-clock";

/**
 * A2.1 — the 1-second exam clock was lifted out of SectionRunner's render body
 * into this external store so a tick no longer re-renders the question tree.
 * These tests pin the behaviour that MUST stay identical to the old in-body
 * interval: one tick per second, a once-only expiry callback (the timed
 * auto-submit `onFinish(true)`), and a synchronously-readable latest value for
 * the crash-safe draft flush.
 */
describe("ClockStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts down one second per tick and notifies subscribers", () => {
    const store = new ClockStore(5);
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.get()));
    store.start(() => {});

    expect(store.get()).toBe(5);
    vi.advanceTimersByTime(1000);
    expect(store.get()).toBe(4);
    vi.advanceTimersByTime(2000);
    expect(store.get()).toBe(2);
    expect(seen).toEqual([4, 3, 2]);
  });

  it("fires the expiry callback exactly once on reaching zero, then stops", () => {
    const store = new ClockStore(2);
    const onExpire = vi.fn();
    store.start(onExpire);

    vi.advanceTimersByTime(1000); // 2 -> 1
    expect(onExpire).not.toHaveBeenCalled();
    expect(store.hasFinished()).toBe(false);

    vi.advanceTimersByTime(1000); // 1 -> 0, expire
    expect(store.get()).toBe(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(store.hasFinished()).toBe(true);

    // No further ticks or extra expiry fires after it has finished.
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(0);
  });

  it("exposes the latest value synchronously for the crash-safe draft", () => {
    const store = new ClockStore(10);
    store.start(() => {});
    vi.advanceTimersByTime(3000);
    // The draft flush reads clock.get() directly (no React state) — must be fresh.
    expect(store.get()).toBe(7);
  });

  it("stop() is idempotent and halts ticking without firing expiry", () => {
    const store = new ClockStore(10);
    const onExpire = vi.fn();
    store.start(onExpire);
    vi.advanceTimersByTime(1000);
    store.stop();
    store.stop(); // idempotent
    vi.advanceTimersByTime(5000);
    expect(store.get()).toBe(9);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("setOnExpire swaps the callback without restarting the interval", () => {
    const store = new ClockStore(2);
    const first = vi.fn();
    const second = vi.fn();
    store.start(first);
    vi.advanceTimersByTime(1000); // 2 -> 1, interval keeps running
    store.setOnExpire(second);
    vi.advanceTimersByTime(1000); // 1 -> 0, expire fires the LATEST callback
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not start a second interval if start is called twice", () => {
    const store = new ClockStore(10);
    store.start(() => {});
    store.start(() => {}); // ignored — interval already running
    vi.advanceTimersByTime(1000);
    // A single interval means a single decrement per second.
    expect(store.get()).toBe(9);
  });

  it("unsubscribe stops further notifications", () => {
    const store = new ClockStore(10);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.start(() => {});
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    vi.advanceTimersByTime(3000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
