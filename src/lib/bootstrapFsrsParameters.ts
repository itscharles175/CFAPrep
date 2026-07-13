/**
 * Apply the user's persisted FSRS parameters (if any) at app startup.
 *
 * Read the `fsrs-custom-parameters` slot from storage and hand it to
 * `setSchedulerParameters`.  The scheduler stays on FSRS-4.5 library
 * defaults when nothing has been fit yet.  Best-effort and silent — a
 * missing or corrupted slot is fine, we just skip it.
 */

import { readPersistedParameters } from './fsrsOptimizer';
import { setSchedulerParameters } from './scheduler';

export async function bootstrapFsrsParameters(): Promise<void> {
  try {
    const persisted = await readPersistedParameters();
    if (!persisted) return;
    setSchedulerParameters({
      request_retention: persisted.request_retention,
      w: persisted.w,
    });
  } catch {
    /* swallow — FSRS defaults remain in effect */
  }
}
