/**
 * computeWorker tests
 *
 * jsdom doesn't run real Workers, so we install a fake worker factory that
 * invokes the underlying compute functions in-process.  This lets us assert
 * the request/response routing, error handling, and concurrency semantics
 * without requiring a real worker runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setWorkerFactoryForTesting,
  computePsychometricsInWorker,
  fitFSRSInWorker,
  terminateComputeWorker,
  type WorkerLike,
  type WorkerResponse,
} from './computeWorker';
import { fitFSRSParameters } from './fsrsOptimizer';
import { computePsychometrics } from './itemPsychometrics';
import type { Confidence, QuestionResult } from './learningTypes';
import { db } from './progressStore';

const DAY_MS = 24 * 60 * 60 * 1000;

function review(
  questionId: string,
  daysAgo: number,
  correct: boolean,
  topic = 'quant',
  confidence: Confidence = 'medium',
): QuestionResult {
  return {
    domain: 'cfa',
    topic,
    questionId,
    learningObjective: `${topic}::lo`,
    correct,
    confidence,
    errorCategory: 'none',
    difficulty: 'intermediate',
    createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  };
}

/**
 * Build a fake worker that delegates to the in-process compute functions.
 * The `handler` override lets individual tests inject custom routing — e.g.
 * to simulate an error reply.
 */
function makeFakeWorker(
  handler?: (request: { id: number; payload: unknown }) => Promise<WorkerResponse>,
): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    async postMessage(message: unknown) {
      const request = message as { id: number; payload: { type: string; results?: QuestionResult[]; startingParameters?: { request_retention?: number; w?: number[] } } };
      let response: WorkerResponse;
      try {
        if (handler) {
          response = await handler(request);
        } else if (request.payload.type === 'fit-fsrs') {
          const result = await fitFSRSParameters(request.payload.results ?? [], request.payload.startingParameters);
          response = { id: request.id, ok: true, result };
        } else if (request.payload.type === 'compute-psychometrics') {
          const result = computePsychometrics(request.payload.results ?? []);
          response = { id: request.id, ok: true, result };
        } else {
          response = { id: request.id, ok: false, error: `Unknown payload type ${request.payload.type}` };
        }
      } catch (err) {
        response = { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // Deliver asynchronously so tests can interleave concurrent calls.
      queueMicrotask(() => {
        worker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
      });
    },
    terminate() {
      worker.onmessage = null;
      worker.onerror = null;
    },
  };
  return worker;
}

beforeEach(async () => {
  await db.settings.clear();
  __setWorkerFactoryForTesting(() => makeFakeWorker());
});

afterEach(() => {
  __setWorkerFactoryForTesting(null);
  terminateComputeWorker();
});

describe('computePsychometricsInWorker', () => {
  it('returns the same shape as computePsychometrics', async () => {
    const rows: QuestionResult[] = [
      review('q1', 5, true),
      review('q1', 4, true),
      review('q1', 3, true),
      review('q2', 4, false),
      review('q2', 3, false),
      review('q2', 2, false),
    ];
    const inWorker = await computePsychometricsInWorker(rows);
    const inProcess = computePsychometrics(rows);
    expect(inWorker.totalAttempts).toBe(inProcess.totalAttempts);
    expect(inWorker.totalItems).toBe(inProcess.totalItems);
    expect(inWorker.itemsByFlag).toEqual(inProcess.itemsByFlag);
    expect(inWorker.items.map((i) => i.questionId).sort()).toEqual(
      inProcess.items.map((i) => i.questionId).sort(),
    );
  });
});

describe('fitFSRSInWorker', () => {
  it('returns the same shape as fitFSRSParameters', async () => {
    const rows: QuestionResult[] = [];
    for (let card = 0; card < 30; card++) {
      for (const days of [40, 25, 12, 4]) {
        rows.push(review(`card-${card}`, days, days !== 12));
      }
    }
    const inWorker = await fitFSRSInWorker(rows);
    expect(inWorker.ok).toBe(true);
    expect(inWorker.cardCount).toBe(30);
    expect(typeof inWorker.optimizedLoss).toBe('number');
    expect(Array.isArray(inWorker.optimizedParameters.w)).toBe(true);
    expect(inWorker.optimizedParameters.w.length).toBeGreaterThan(0);
  }, 30_000);

  it('forwards startingParameters through to the worker', async () => {
    const rows: QuestionResult[] = [
      review('q1', 5, true),
      review('q1', 1, true),
    ];
    // Below MIN_TOTAL_REVIEWS — the worker should still return an `ok: false`
    // report that we can inspect.
    const report = await fitFSRSInWorker(rows, { request_retention: 0.88 });
    expect(report.ok).toBe(false);
    expect(report.originalParameters.request_retention).toBe(0.88);
  });
});

describe('concurrent dispatch', () => {
  it('routes each response back to the right caller', async () => {
    const rowsA: QuestionResult[] = [
      review('q1', 3, true),
      review('q1', 2, true),
      review('q1', 1, false),
    ];
    const rowsB: QuestionResult[] = [
      review('q2', 3, false),
      review('q2', 2, false),
      review('q2', 1, false),
    ];
    const [a, b] = await Promise.all([
      computePsychometricsInWorker(rowsA),
      computePsychometricsInWorker(rowsB),
    ]);
    expect(a.items[0].questionId).toBe('q1');
    expect(b.items[0].questionId).toBe('q2');
    expect(b.items[0].flag).toBe('too-hard');
  });

  it('three in-flight calls each resolve with the right report', async () => {
    const promises = Array.from({ length: 3 }, (_, i) =>
      computePsychometricsInWorker([
        review(`qX-${i}`, 3, true),
        review(`qX-${i}`, 2, true),
        review(`qX-${i}`, 1, true),
      ]),
    );
    const reports = await Promise.all(promises);
    for (let i = 0; i < reports.length; i++) {
      expect(reports[i].items[0]?.questionId).toBe(`qX-${i}`);
    }
  });
});

describe('error handling', () => {
  it('rejects with the worker-side error message', async () => {
    __setWorkerFactoryForTesting(() =>
      makeFakeWorker(async ({ id }) => ({ id, ok: false, error: 'boom from worker' })),
    );
    await expect(
      computePsychometricsInWorker([review('q1', 1, true)]),
    ).rejects.toThrow(/boom from worker/);
  });

  it('rejects in-flight requests when the worker emits an error event', async () => {
    let outerWorker: WorkerLike | null = null;
    __setWorkerFactoryForTesting(() => {
      const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage() {
          // Never reply; instead fire an error event on the next tick.
          queueMicrotask(() => {
            w.onerror?.(new ErrorEvent('error', { message: 'worker crashed' }));
          });
        },
        terminate() {},
      };
      outerWorker = w;
      return w;
    });
    await expect(
      computePsychometricsInWorker([review('q1', 1, true)]),
    ).rejects.toThrow(/worker crashed/);
    expect(outerWorker).not.toBeNull();
  });
});
