/**
 * Main-thread API for the compute Worker.
 *
 * Lazily spawns a single Worker on first use, then routes typed RPC-style
 * messages through a request-id counter + a Map<id, deferred>.  If the worker
 * errors out, all in-flight requests reject and the worker is torn down so the
 * next call gets a fresh one.
 *
 * In tests, the real Worker constructor isn't available under jsdom; consumers
 * can override the worker factory via `__setWorkerFactoryForTesting`.
 */

import type { FSRSFitReport } from './fsrsOptimizer';
import type { PsychometricsReport } from './itemPsychometrics';
import type { QuestionResult } from './learningTypes';
import type { ComputeRequest } from './computeWorker.worker';
// The `?worker` query tells Vite to compile the imported module as a Web
// Worker entry and emit a constructor that spawns it.  See:
//   https://vitejs.dev/guide/features.html#import-with-constructors
import ComputeWorkerCtor from './computeWorker.worker.ts?worker';

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingDeferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

type WorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent | Event) => void) | null;
};

let workerInstance: WorkerLike | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingDeferred>();
let workerFactory: () => WorkerLike = defaultWorkerFactory;

function defaultWorkerFactory(): WorkerLike {
  // Vite's `?worker` import gives us a constructor that emits a proper worker
  // chunk (with the right `application/javascript` mime type and module type
  // when configured).  In Vitest this branch isn't hit — tests install a fake
  // factory via `__setWorkerFactoryForTesting`.
  return new ComputeWorkerCtor() as unknown as WorkerLike;
}

function ensureWorker(): WorkerLike {
  if (workerInstance) return workerInstance;
  const worker = workerFactory();
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, ok, result, error } = event.data;
    const deferred = pending.get(id);
    if (!deferred) return;
    pending.delete(id);
    if (ok) deferred.resolve(result);
    else deferred.reject(new Error(error ?? 'Worker rejected the request without a reason.'));
  };
  worker.onerror = (event) => {
    const message =
      event instanceof ErrorEvent
        ? event.message || 'Compute worker errored.'
        : 'Compute worker errored.';
    // Reject every in-flight request, then drop the worker so the next call
    // gets a fresh one.
    for (const deferred of pending.values()) {
      deferred.reject(new Error(message));
    }
    pending.clear();
    try {
      worker.terminate();
    } catch {
      /* swallow — terminate is best-effort during error recovery */
    }
    workerInstance = null;
  };
  workerInstance = worker;
  return worker;
}

function dispatch<T>(payload: ComputeRequest): Promise<T> {
  const worker = ensureWorker();
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    try {
      worker.postMessage({ id, payload });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Run the FSRS coordinate-descent fit off the main thread. */
export function fitFSRSInWorker(
  results: QuestionResult[],
  startingParameters?: { request_retention?: number; w?: number[] },
): Promise<FSRSFitReport> {
  return dispatch<FSRSFitReport>({ type: 'fit-fsrs', results, startingParameters });
}

/** Run the IRT-lite psychometrics compute off the main thread. */
export function computePsychometricsInWorker(
  results: QuestionResult[],
): Promise<PsychometricsReport> {
  return dispatch<PsychometricsReport>({ type: 'compute-psychometrics', results });
}

/** Tear down the worker (used in tests and during page teardown). */
export function terminateComputeWorker(): void {
  if (!workerInstance) {
    pending.clear();
    return;
  }
  try {
    workerInstance.terminate();
  } catch {
    /* swallow */
  }
  workerInstance = null;
  // Reject any stragglers so callers don't hang.
  for (const deferred of pending.values()) {
    deferred.reject(new Error('Compute worker terminated.'));
  }
  pending.clear();
}

/**
 * Test-only hook to install a fake worker factory.  Calling this also tears
 * down any existing worker so the next dispatch will use the new factory.
 */
export function __setWorkerFactoryForTesting(factory: (() => WorkerLike) | null): void {
  terminateComputeWorker();
  workerFactory = factory ?? defaultWorkerFactory;
}

export type { WorkerLike, WorkerResponse };
