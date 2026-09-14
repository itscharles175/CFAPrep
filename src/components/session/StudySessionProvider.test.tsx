import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { StudySessionProvider, useStudySession } from './StudySessionProvider';

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

describe('StudySessionProvider', () => {
  it('keeps a failed save checkpoint and retries the same answer totals', async () => {
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const storage = memoryStorage();
    const recorder = vi.fn()
      .mockRejectedValueOnce(new Error('Vault unavailable'))
      .mockResolvedValueOnce(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudySessionProvider recorder={recorder} storage={storage} now={() => now}>
        {children}
      </StudySessionProvider>
    );
    const { result } = renderHook(() => useStudySession(), { wrapper });

    act(() => result.current.start({ questionsAnswered: 2, score: 1 }));
    now += 12_000;
    await act(async () => { await result.current.stopAndSave(); });
    expect(result.current.session).toMatchObject({ status: 'save-error', questionsAnswered: 2, score: 1 });
    expect(result.current.session?.saveError).toMatch(/vault unavailable/i);

    await act(async () => { await result.current.retrySave(); });
    expect(result.current.session).toBeNull();
    expect(recorder).toHaveBeenCalledTimes(2);
    expect(recorder.mock.calls[1][0]).toMatchObject({ elapsedSeconds: 12, questionsAnswered: 2, score: 1 });
  });

  it('does not log accidental sessions of five seconds or less', async () => {
    let now = 10_000;
    const recorder = vi.fn().mockResolvedValue(undefined);
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudySessionProvider recorder={recorder} storage={storage} now={() => now}>
        {children}
      </StudySessionProvider>
    );
    const { result } = renderHook(() => useStudySession(), { wrapper });
    act(() => result.current.start());
    now += 5_000;
    await act(async () => { await result.current.stopAndSave(); });
    expect(recorder).not.toHaveBeenCalled();
    expect(result.current.session).toBeNull();
  });
});
