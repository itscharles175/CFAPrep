import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API client so flushing never hits the network. Each method is a spy
// we can make resolve (success) or reject (still offline).
const createAttemptsBatch = vi.fn();
const finishSession = vi.fn();
const createAttempt = vi.fn();
const blindReview = vi.fn();
const addErrorLog = vi.fn();

vi.mock("./api", () => ({
  api: {
    createAttemptsBatch: (...a: unknown[]) => createAttemptsBatch(...a),
    finishSession: (...a: unknown[]) => finishSession(...a),
    createAttempt: (...a: unknown[]) => createAttempt(...a),
    blindReview: (...a: unknown[]) => blindReview(...a),
    addErrorLog: (...a: unknown[]) => addErrorLog(...a),
  },
}));

import {
  enqueue,
  enqueueSectionAttempts,
  flushQueue,
  getQueueDepth,
  startAutoFlush,
  stopAutoFlush,
} from "./offlineQueue";
import type { AttemptCreateWire } from "./apiTypes";

function attempt(qid: number, cid: string): AttemptCreateWire {
  return {
    question_id: qid,
    mode: "timed",
    chosen_answer: "A",
    time_ms: 1000,
    flagged: false,
    choice_events: [],
    client_attempt_id: cid,
  };
}

describe("offlineQueue (5.2)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    stopAutoFlush();
    // Default: API up so resolved spies make flush succeed.
    createAttemptsBatch.mockResolvedValue({ results: [], created: 0, duplicates: 0, total: 0 });
    finishSession.mockResolvedValue({ raw_correct: 0, total: 0 });
    createAttempt.mockResolvedValue({ attempt_id: 1 });
    addErrorLog.mockResolvedValue({ id: 1 });
  });
  afterEach(() => {
    stopAutoFlush();
    vi.useRealTimers();
  });

  it("enqueues a batch and counts depth by attempts, not requests", async () => {
    // While 'offline' the batch should stay queued.
    createAttemptsBatch.mockRejectedValue(new Error("offline"));
    enqueueSectionAttempts(5, [attempt(1, "a"), attempt(2, "b"), attempt(3, "c")]);
    // enqueue triggers a best-effort flush; let it settle.
    await Promise.resolve();
    await flushQueue();
    expect(getQueueDepth()).toBe(3); // 3 attempts in one batch item
  });

  it("de-dups attempts already queued so a partial replay can't double-submit", async () => {
    createAttemptsBatch.mockRejectedValue(new Error("offline"));
    enqueueSectionAttempts(5, [attempt(1, "a"), attempt(2, "b")]);
    await flushQueue(); // fails, stays queued
    // Re-enqueue the same batch plus one new attempt (a partial-success replay).
    enqueueSectionAttempts(5, [attempt(1, "a"), attempt(2, "b"), attempt(3, "c")]);
    await flushQueue();
    // a + b already queued -> only c is added. Total distinct attempts = 3.
    expect(getQueueDepth()).toBe(3);
  });

  it("de-dups a finishSession so only one is ever queued", async () => {
    finishSession.mockRejectedValue(new Error("offline"));
    enqueue({ kind: "finishSession", sessionId: 9 });
    await flushQueue();
    enqueue({ kind: "finishSession", sessionId: 9 });
    await flushQueue();
    expect(getQueueDepth()).toBe(1);
  });

  it("flushQueue drains successful writes and reports counts", async () => {
    createAttemptsBatch.mockRejectedValueOnce(new Error("offline")); // first attempt fails
    enqueueSectionAttempts(5, [attempt(1, "a")]);
    enqueue({ kind: "finishSession", sessionId: 5 });
    await flushQueue(); // batch fails, finish succeeds
    expect(getQueueDepth()).toBe(1); // batch remains

    createAttemptsBatch.mockResolvedValue({ results: [], created: 1, duplicates: 0, total: 1 });
    const res = await flushQueue();
    expect(res.flushed).toBe(1);
    expect(res.failed).toBe(0);
    expect(getQueueDepth()).toBe(0);
  });

  it("requeues only the failed items on a partial-success flush (order preserved)", async () => {
    // Queue three heterogeneous writes; make the MIDDLE one (finishSession) fail
    // while the batch + error-log succeed. Only the failed item should remain.
    // Suppress the eager flush that `enqueue` fires while "online" by forcing
    // navigator.onLine=false during enqueueing, so the single explicit
    // flushQueue() below is the only drain and the counts are deterministic.
    const onLineSpy = vi
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);

    createAttemptsBatch.mockResolvedValue({ results: [], created: 1, duplicates: 0, total: 1 });
    finishSession.mockRejectedValue(new Error("offline"));
    addErrorLog.mockResolvedValue({ id: 1 });

    enqueueSectionAttempts(3, [attempt(1, "a")]);
    enqueue({ kind: "finishSession", sessionId: 3 });
    enqueue({
      kind: "addErrorLog",
      attemptId: 50,
      body: { reason: "concept", note: "x" },
    });
    expect(getQueueDepth()).toBe(3); // nothing flushed yet (still "offline")

    onLineSpy.mockReturnValue(true);
    const res = await flushQueue();
    // batch (1) + error-log (1) flushed; finish failed and is requeued.
    expect(res.flushed).toBe(2);
    expect(res.failed).toBe(1);
    expect(finishSession).toHaveBeenCalled();
    // Depth now reflects only the single remaining finishSession item.
    expect(getQueueDepth()).toBe(1);

    // When the backend recovers, the requeued finish drains cleanly.
    finishSession.mockResolvedValue({ raw_correct: 0, total: 0 });
    const res2 = await flushQueue();
    expect(res2.flushed).toBe(1);
    expect(getQueueDepth()).toBe(0);
    onLineSpy.mockRestore();
  });

  it("auto-flushes on the window 'online' event", async () => {
    createAttemptsBatch.mockRejectedValue(new Error("offline"));
    enqueueSectionAttempts(7, [attempt(1, "x")]);
    await flushQueue();
    expect(getQueueDepth()).toBe(1);

    // Now the API is back; firing 'online' should drain the queue.
    createAttemptsBatch.mockResolvedValue({ results: [], created: 1, duplicates: 0, total: 1 });
    startAutoFlush();
    window.dispatchEvent(new Event("online"));
    // Allow the async flush to settle.
    await vi.waitFor(() => expect(getQueueDepth()).toBe(0));
  });

  it("auto-flushes on the periodic tick", async () => {
    vi.useFakeTimers();
    createAttemptsBatch.mockRejectedValue(new Error("offline"));
    enqueueSectionAttempts(8, [attempt(1, "y")]);
    await flushQueue();
    expect(getQueueDepth()).toBe(1);

    createAttemptsBatch.mockResolvedValue({ results: [], created: 1, duplicates: 0, total: 1 });
    startAutoFlush(1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(getQueueDepth()).toBe(0);
  });

  it("a concurrent flush does not replay the same item twice", async () => {
    // Slow, resolving batch so two flushes can overlap.
    let resolveBatch: (v: unknown) => void = () => {};
    createAttemptsBatch.mockImplementation(
      () => new Promise((r) => (resolveBatch = r)),
    );
    enqueueSectionAttempts(11, [attempt(1, "z")]);

    const f1 = flushQueue();
    const f2 = flushQueue(); // should join the in-flight flush, not start a new one
    resolveBatch({ results: [], created: 1, duplicates: 0, total: 1 });
    await Promise.all([f1, f2]);

    // enqueue itself fires one best-effort flush + our two explicit calls, but
    // the guard collapses overlapping flushes: exactly one batch call total.
    expect(createAttemptsBatch).toHaveBeenCalledTimes(1);
    expect(getQueueDepth()).toBe(0);
  });
});
