/**
 * GAP-CLOCK-1 — examTimer tests.
 *
 * The timer's defining property is that it's anchored to a wall-clock deadline,
 * so we drive it with an injectable `now` and an in-memory store (no real
 * setInterval/Date dependence) and assert it never trusts a missed tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExamTimer,
  clearExamTimerState,
  formatRemaining,
  loadExamTimerState,
} from './examTimer';

function memStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

describe('examTimer (GAP-CLOCK-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes remaining from the wall clock, not from elapsed ticks', () => {
    let t = 1_000_000;
    const timer = new ExamTimer({ id: 'a', durationMs: 60_000, now: () => t, storage: memStore() });
    expect(timer.read().remainingSeconds).toBe(60);
    // Simulate the tab being frozen: the clock jumps 50s with NO ticks fired.
    t += 50_000;
    expect(timer.read().remainingSeconds).toBe(10);
    timer.dispose();
  });

  it('is throttle/sleep-resistant: a single tick after a long sleep reflects true remaining', () => {
    let t = 0;
    const ticks: number[] = [];
    const timer = new ExamTimer({ id: 'b', durationMs: 30_000, now: () => t, storage: memStore(), tickMs: 1000 });
    timer.start({ onTick: (tick) => ticks.push(tick.remainingSeconds) });
    // Machine sleeps 29s; only ONE heartbeat fires on wake.
    t += 29_000;
    vi.advanceTimersByTime(1000);
    expect(ticks.at(-1)).toBe(1);
    timer.dispose();
  });

  it('fires onExpire exactly once when the deadline passes', () => {
    let t = 0;
    const onExpire = vi.fn();
    const timer = new ExamTimer({ id: 'c', durationMs: 5000, now: () => t, storage: memStore(), tickMs: 1000 });
    timer.start({ onExpire });
    t += 6000;
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(timer.read().expired).toBe(true);
    timer.dispose();
  });

  it('persists state and resumes against the SAME deadline after a crash/reload', () => {
    const store = memStore();
    let t = 100_000;
    const first = new ExamTimer({ id: 'resume', durationMs: 60_000, now: () => t, storage: store });
    const deadline = loadExamTimerState('resume', store)?.deadlineMs;
    expect(deadline).toBe(160_000);
    first.dispose();

    // "Crash": 20s of wall time pass with no live timer, then we re-create it.
    t += 20_000;
    const resumed = new ExamTimer({ id: 'resume', durationMs: 60_000, now: () => t, storage: store });
    // Deadline unchanged, so remaining reflects the wall time that elapsed.
    expect(resumed.read().remainingSeconds).toBe(40);
    resumed.dispose();
  });

  it('preserves remaining time across pause/resume', () => {
    let t = 0;
    const timer = new ExamTimer({ id: 'p', durationMs: 60_000, now: () => t, storage: memStore() });
    t += 10_000; // 50s left
    timer.pause();
    expect(timer.read().remainingSeconds).toBe(50);
    expect(timer.read().paused).toBe(true);
    // 25s pass while paused — remaining must NOT shrink.
    t += 25_000;
    expect(timer.read().remainingSeconds).toBe(50);
    timer.resume();
    expect(timer.read().paused).toBe(false);
    // After resume, the deadline was pushed forward; still 50s.
    expect(timer.read().remainingSeconds).toBe(50);
    t += 20_000;
    expect(timer.read().remainingSeconds).toBe(30);
    timer.dispose();
  });

  it('reset gives a fresh full-duration deadline and re-arms expiry', () => {
    let t = 0;
    const onExpire = vi.fn();
    const timer = new ExamTimer({ id: 'r', durationMs: 10_000, now: () => t, storage: memStore(), tickMs: 1000 });
    timer.start({ onExpire });
    t += 11_000;
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    timer.reset();
    expect(timer.read().remainingSeconds).toBe(10);
    t += 11_000;
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(2);
    timer.dispose();
  });

  it('clearExamTimerState removes persistence (no resume)', () => {
    const store = memStore();
    let t = 0;
    new ExamTimer({ id: 'gone', durationMs: 1000, now: () => t, storage: store }).dispose();
    expect(loadExamTimerState('gone', store)).not.toBeNull();
    clearExamTimerState('gone', store);
    expect(loadExamTimerState('gone', store)).toBeNull();
  });

  it('drops a persisted state whose duration no longer matches (config changed)', () => {
    const store = memStore();
    let t = 0;
    new ExamTimer({ id: 'cfg', durationMs: 30_000, now: () => t, storage: store }).dispose();
    t += 5000;
    // Re-create with a DIFFERENT duration → fresh deadline, not the stale one.
    const next = new ExamTimer({ id: 'cfg', durationMs: 60_000, now: () => t, storage: store });
    expect(next.read().remainingSeconds).toBe(60);
    next.dispose();
  });

  it('tolerates a corrupt persisted entry', () => {
    const store = memStore();
    store.setItem('quantvault:exam-timer:bad', '{not json');
    expect(loadExamTimerState('bad', store)).toBeNull();
  });

  it('formatRemaining renders MM:SS and H:MM:SS', () => {
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(5_000)).toBe('00:05');
    expect(formatRemaining(95_000)).toBe('01:35');
    expect(formatRemaining(3_725_000)).toBe('1:02:05');
    expect(formatRemaining(-10)).toBe('00:00');
  });
});
