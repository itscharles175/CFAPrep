// Persisted queue for API writes that failed while offline or unreachable.
//
// 5.2 — the queue is now:
//   - batch-first: a finished section enqueues ONE `batchAttempts` item (each
//     carrying a `client_attempt_id`) instead of N serial `createAttempt`s.
//   - idempotent + de-duped: replaying a partial-success batch can't double-
//     submit (the backend collapses on `client_attempt_id`, and we drop already-
//     queued attempts so the local queue never holds the same id twice).
//   - auto-flushing: an `online` event and a periodic timer drain the queue, so
//     pending writes sync without the user pressing "Sync now" (which still works).
import { api } from "./api";
import { STORAGE_KEYS, getJSON, setJSON } from "./storage";
import type { AttemptCreateWire } from "./apiTypes";
import type { CreateAttemptBody, ErrorReason } from "./types";

const K_QUEUE = STORAGE_KEYS.offlineQueue;

export type QueueItem =
  | {
      id: string;
      kind: "createAttempt";
      sessionId: number;
      body: CreateAttemptBody;
      createdAt: string;
    }
  | {
      // 5.2 — one section's worth of attempts, written in a single request.
      id: string;
      kind: "batchAttempts";
      sessionId: number;
      attempts: AttemptCreateWire[];
      createdAt: string;
    }
  | {
      id: string;
      kind: "finishSession";
      sessionId: number;
      createdAt: string;
    }
  | {
      id: string;
      kind: "blindReview";
      attemptId: number;
      body: { br_answer: string; confidence: string };
      createdAt: string;
    }
  | {
      id: string;
      kind: "addErrorLog";
      attemptId: number;
      body: { reason: ErrorReason; note: string };
      createdAt: string;
    }
  | {
      // R10 A4.1 — an optimistic SRS grade whose background review failed; the
      // FSRS rating (1..4) replays verbatim when the backend returns.
      id: string;
      kind: "srsReview";
      cardId: number;
      rating: 1 | 2 | 3 | 4;
      createdAt: string;
    };

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

function readQueue(): QueueItem[] {
  const parsed = getJSON<QueueItem[]>(K_QUEUE, []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeQueue(items: QueueItem[]): void {
  setJSON(K_QUEUE, items);
  notify();
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export type EnqueueInput =
  | { kind: "createAttempt"; sessionId: number; body: CreateAttemptBody }
  | { kind: "batchAttempts"; sessionId: number; attempts: AttemptCreateWire[] }
  | { kind: "finishSession"; sessionId: number }
  | {
      kind: "blindReview";
      attemptId: number;
      body: { br_answer: string; confidence: string };
    }
  | {
      kind: "addErrorLog";
      attemptId: number;
      body: { reason: ErrorReason; note: string };
    }
  | { kind: "srsReview"; cardId: number; rating: 1 | 2 | 3 | 4 };

/** Stable client_attempt_ids already present anywhere in the queue. */
function queuedAttemptIds(queue: QueueItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of queue) {
    if (item.kind === "batchAttempts") {
      for (const a of item.attempts) {
        if (a.client_attempt_id) ids.add(a.client_attempt_id);
      }
    } else if (item.kind === "createAttempt") {
      const cid = (item.body as { client_attempt_id?: string | null })
        .client_attempt_id;
      if (cid) ids.add(cid);
    }
  }
  return ids;
}

/**
 * De-dup an enqueue against what's already queued so a partial-success replay
 * can't double-submit. Returns the cleaned item, or null when it's fully
 * redundant (e.g. a finish already queued, or every attempt already present).
 */
function dedup(item: EnqueueInput, queue: QueueItem[]): EnqueueInput | null {
  if (item.kind === "finishSession") {
    // Only ever need one finish per session in the queue.
    const already = queue.some(
      (q) => q.kind === "finishSession" && q.sessionId === item.sessionId,
    );
    return already ? null : item;
  }
  if (item.kind === "batchAttempts") {
    const seen = queuedAttemptIds(queue);
    const attempts = item.attempts.filter(
      (a) => !a.client_attempt_id || !seen.has(a.client_attempt_id),
    );
    if (attempts.length === 0) return null;
    return { ...item, attempts };
  }
  if (item.kind === "createAttempt") {
    const cid = (item.body as { client_attempt_id?: string | null })
      .client_attempt_id;
    if (cid && queuedAttemptIds(queue).has(cid)) return null;
    return item;
  }
  return item;
}

export function enqueue(item: EnqueueInput): void {
  const queue = readQueue();
  const cleaned = dedup(item, queue);
  if (!cleaned) {
    notify(); // nothing added, but keep subscribers in sync
    return;
  }
  const entry = {
    ...cleaned,
    id: newId(),
    createdAt: new Date().toISOString(),
  } as QueueItem;
  writeQueue([...queue, entry]);
  // Best-effort: a fresh enqueue while online should flush promptly.
  if (typeof navigator === "undefined" || navigator.onLine) {
    void flushQueue();
  }
}

export function getQueueDepth(): number {
  // Count attempts inside a batch individually so the banner reflects work, not
  // request count.
  return readQueue().reduce(
    (n, item) =>
      n + (item.kind === "batchAttempts" ? item.attempts.length : 1),
    0,
  );
}

export function subscribeQueue(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function flushOne(item: QueueItem): Promise<void> {
  switch (item.kind) {
    case "createAttempt":
      await api.createAttempt(item.sessionId, item.body);
      break;
    case "batchAttempts":
      await api.createAttemptsBatch(item.sessionId, item.attempts);
      break;
    case "finishSession":
      await api.finishSession(item.sessionId);
      break;
    case "blindReview":
      await api.blindReview(item.attemptId, item.body);
      break;
    case "addErrorLog":
      await api.addErrorLog(item.attemptId, item.body);
      break;
    case "srsReview":
      await api.srsReview(item.cardId, item.rating);
      break;
  }
}

// A single in-flight flush guard so the `online` event, the periodic timer and a
// manual "Sync now" can't run concurrently and replay the same items twice.
let flushing: Promise<{ flushed: number; failed: number }> | null = null;

/** Replay queued writes in order; drops items that succeed. */
export async function flushQueue(): Promise<{ flushed: number; failed: number }> {
  if (flushing) return flushing;
  flushing = (async () => {
    const queue = readQueue();
    if (queue.length === 0) return { flushed: 0, failed: 0 };

    const remaining: QueueItem[] = [];
    let flushed = 0;
    for (const item of queue) {
      try {
        await flushOne(item);
        flushed++;
      } catch {
        remaining.push(item);
      }
    }
    writeQueue(remaining);
    return { flushed, failed: remaining.length };
  })();
  try {
    return await flushing;
  } finally {
    flushing = null;
  }
}

// --- auto-flush wiring ------------------------------------------------------
let autoFlushStarted = false;
let periodicTimer: ReturnType<typeof setInterval> | null = null;

/** Flush whenever connectivity returns, plus on a slow periodic tick. */
export function startAutoFlush(periodMs = 30_000): () => void {
  if (autoFlushStarted) return stopAutoFlush;
  autoFlushStarted = true;

  const onOnline = () => {
    void flushQueue();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }
  periodicTimer = setInterval(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (getQueueDepth() === 0) return;
    void flushQueue();
  }, periodMs);

  return () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
    }
    stopAutoFlush();
  };
}

export function stopAutoFlush(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  autoFlushStarted = false;
}

/** Batch helpers used by exam / review flows. */
export function enqueueSectionAttempts(
  sessionId: number,
  attempts: AttemptCreateWire[],
): void {
  // 5.2 — one batch item (de-duped) rather than N serial createAttempt items.
  enqueue({ kind: "batchAttempts", sessionId, attempts });
}

export function enqueueFinishSession(sessionId: number): void {
  enqueue({ kind: "finishSession", sessionId });
}

/** Remove a queued error-log write (e.g. toast undo). */
export function removeQueuedErrorLog(attemptId: number, note: string): void {
  const next = readQueue().filter(
    (item) =>
      !(
        item.kind === "addErrorLog" &&
        item.attemptId === attemptId &&
        item.body.note === note
      ),
  );
  writeQueue(next);
}
