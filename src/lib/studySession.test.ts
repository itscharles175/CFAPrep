import { describe, expect, it } from 'vitest';
import {
  FOCUS_SESSION_STORAGE_KEY,
  createFocusSession,
  loadFocusSession,
  pauseFocusSession,
  persistFocusSession,
  resumeFocusSession,
  toStudySession,
  updateFocusSessionActivity,
} from './studySession';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('focus study-session checkpoints', () => {
  it('restores a running session as paused at its last checkpoint', () => {
    const storage = memoryStorage();
    const start = Date.parse('2026-09-14T12:00:00.000Z');
    const session = createFocusSession({ domain: 'cfa', topic: 'cfa:ethics' }, start);
    persistFocusSession({ ...session, updatedAt: new Date(start + 20_000).toISOString() }, storage);

    const restored = loadFocusSession(storage, start + 60_000);
    expect(restored).toMatchObject({ status: 'paused', accumulatedMs: 20_000, topic: 'cfa:ethics' });
  });

  it('counts submitted answers rather than generated questions', () => {
    const start = Date.parse('2026-09-14T12:00:00.000Z');
    let session = createFocusSession({}, start);
    session = updateFocusSessionActivity(session, { questionsAnswered: 2, score: 1 }, start + 1_000);
    session = pauseFocusSession(session, start + 9_000);

    expect(toStudySession(session, start + 9_000)).toMatchObject({
      elapsedSeconds: 9,
      questionsAnswered: 2,
      score: 1,
    });
  });

  it('preserves elapsed time across pause and resume', () => {
    const start = Date.parse('2026-09-14T12:00:00.000Z');
    const paused = pauseFocusSession(createFocusSession({}, start), start + 8_000);
    const resumed = resumeFocusSession(paused, start + 30_000);
    const final = pauseFocusSession(resumed, start + 35_000);
    expect(final.accumulatedMs).toBe(13_000);
  });

  it('rejects corrupt persisted checkpoints', () => {
    const storage = memoryStorage();
    storage.setItem(FOCUS_SESSION_STORAGE_KEY, '{"version":1,"status":"running"}');
    expect(loadFocusSession(storage)).toBeNull();
  });
});
