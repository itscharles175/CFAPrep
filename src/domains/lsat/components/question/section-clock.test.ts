import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClockStore } from "./section-clock";

describe("ClockStore (GAP-CLOCK-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes remaining from the wall-clock deadline, not elapsed ticks", () => {
    let now = 1_000_000;
    const clock = new ClockStore(60, { now: () => now });

    expect(clock.get()).toBe(60);
    now += 50_000;
    expect(clock.get()).toBe(10);
  });

  it("is throttle/sleep-resistant on the next render heartbeat", () => {
    let now = 0;
    const ticks: number[] = [];
    const clock = new ClockStore(30, { now: () => now });
    clock.subscribe(() => ticks.push(clock.get()));

    clock.start(() => {});
    now += 29_000;
    vi.advanceTimersByTime(1000);

    expect(ticks.at(-1)).toBe(1);
    clock.stop();
  });

  it("fires expiry exactly once when the deadline has passed", () => {
    let now = 0;
    const expired = vi.fn();
    const clock = new ClockStore(5, { now: () => now });

    clock.start(expired);
    now += 6_000;
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(clock.get()).toBe(0);
    expect(clock.hasFinished()).toBe(true);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("resumes from a persisted deadline", () => {
    let now = 120_000;
    const clock = new ClockStore(60, { now: () => now, deadlineMs: 160_000 });

    expect(clock.getDeadlineMs()).toBe(160_000);
    expect(clock.get()).toBe(40);
    now += 20_000;
    expect(clock.get()).toBe(20);
  });
});
