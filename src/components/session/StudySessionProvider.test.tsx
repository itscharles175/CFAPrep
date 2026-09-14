import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type {
  StudyVaultBeforeQuitEvent,
  StudyVaultBridge,
  StudyVaultLifecycleEvent,
} from '../../lib/desktopBridge';
import { FOCUS_SESSION_STORAGE_KEY } from '../../lib/studySession';
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
  it('serializes and resumes an LSAT focus session with its attribution intact', () => {
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudySessionProvider storage={storage} now={() => now}>
        {children}
      </StudySessionProvider>
    );
    const first = renderHook(() => useStudySession(), { wrapper });

    act(() => first.result.current.start({ domain: 'lsat', topic: 'lsat:section' }));
    expect(JSON.parse(storage.getItem(FOCUS_SESSION_STORAGE_KEY) || '{}')).toMatchObject({
      domain: 'lsat',
      topic: 'lsat:section',
      status: 'running',
    });
    first.unmount();

    now += 30_000;
    const resumed = renderHook(() => useStudySession(), { wrapper });
    expect(resumed.result.current.session).toMatchObject({
      domain: 'lsat',
      topic: 'lsat:section',
      status: 'paused',
    });
    resumed.unmount();
  });

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

  it('pauses ordinary focus time on native suspend without consuming sleep time', () => {
    let now = 10_000;
    let emitLifecycle: ((event: StudyVaultLifecycleEvent) => void) | undefined;
    window.studyvault = {
      events: {
        onLifecycle: (handler: (event: StudyVaultLifecycleEvent) => void) => {
          emitLifecycle = handler;
          return () => { emitLifecycle = undefined; };
        },
      },
    } as unknown as StudyVaultBridge;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudySessionProvider storage={memoryStorage()} now={() => now}>{children}</StudySessionProvider>
    );
    const { result, unmount } = renderHook(() => useStudySession(), { wrapper });

    act(() => result.current.start());
    now = 30_000;
    act(() => emitLifecycle?.({ state: 'suspend', at: now }));
    expect(result.current.session?.status).toBe('paused');
    expect(result.current.elapsedSeconds).toBe(20);

    now = 90_000;
    act(() => emitLifecycle?.({ state: 'resume', at: now }));
    expect(result.current.elapsedSeconds).toBe(20);

    unmount();
    delete window.studyvault;
  });

  it('checkpoints the active session and acknowledges a bounded native quit flush', async () => {
    let emitBeforeQuit: ((event: { requestId: string; at: number }) => void) | undefined;
    const acknowledgeBeforeQuit = vi.fn().mockResolvedValue({ ok: true });
    const flushPendingWrites = vi.fn().mockResolvedValue(undefined);
    window.studyvault = {
      lifecycle: { acknowledgeBeforeQuit },
      events: {
        onBeforeQuit: (handler: (event: StudyVaultBeforeQuitEvent) => void) => {
          emitBeforeQuit = handler;
          return () => { emitBeforeQuit = undefined; };
        },
      },
    } as unknown as StudyVaultBridge;
    let now = 10_000;
    const storage = memoryStorage();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudySessionProvider storage={storage} now={() => now} flushPendingWrites={flushPendingWrites}>
        {children}
      </StudySessionProvider>
    );
    const { result } = renderHook(() => useStudySession(), { wrapper });
    act(() => result.current.start({ topic: 'cfa:ethics' }));

    now = 25_000;
    await act(async () => {
      emitBeforeQuit?.({ requestId: 'quit-1', at: now });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flushPendingWrites).toHaveBeenCalledTimes(1);
    expect(acknowledgeBeforeQuit).toHaveBeenCalledWith('quit-1');
    expect(storage.getItem('studyvault.focus-session.v1')).toContain('1970-01-01T00:00:25.000Z');
    delete window.studyvault;
  });
});
