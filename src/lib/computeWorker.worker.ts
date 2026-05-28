/**
 * Web Worker entry point for compute-heavy operations.
 *
 * Hosts the FSRS parameter fit and the IRT-lite psychometrics compute, both of
 * which can take seconds on a real review history and would otherwise lock up
 * the main thread (and block paint).  See `computeWorker.ts` for the
 * main-thread API.
 *
 * Protocol:
 *   in:  { id: number; payload: ComputeRequest }
 *   out: { id: number; ok: true; result } | { id: number; ok: false; error: string }
 */

import { fitFSRSParameters } from './fsrsOptimizer';
import { computePsychometrics } from './itemPsychometrics';
import type { QuestionResult } from './learningTypes';

export type ComputeRequest =
  | { type: 'fit-fsrs'; results: QuestionResult[]; startingParameters?: { request_retention?: number; w?: number[] } }
  | { type: 'compute-psychometrics'; results: QuestionResult[] };

interface IncomingMessage {
  id: number;
  payload: ComputeRequest;
}

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const { id, payload } = event.data;
  try {
    let result: unknown;
    if (payload.type === 'fit-fsrs') {
      result = await fitFSRSParameters(payload.results, payload.startingParameters);
    } else if (payload.type === 'compute-psychometrics') {
      result = computePsychometrics(payload.results);
    } else {
      // Exhaustiveness check — if the union grows and this branch is reached,
      // the worker will reject with a useful message.
      const unknownPayload = payload as { type?: string };
      throw new Error(`Unknown compute payload type: ${unknownPayload.type ?? 'undefined'}`);
    }
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: false, error });
  }
};
