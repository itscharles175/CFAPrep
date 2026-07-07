import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamExplain, streamSocraticTurn } from './api';

const enc = new TextEncoder();

/** A fake fetch Response whose body reader yields the given chunk plan. */
function sseResponse(
  chunks: Array<{ data?: string; throwErr?: Error }>,
  init?: { ok?: boolean; status?: number },
): Response {
  let i = 0;
  const reader = {
    read() {
      if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
      const step = chunks[i++];
      if (step.throwErr) return Promise.reject(step.throwErr);
      return Promise.resolve({
        done: false,
        value: enc.encode(`data: ${step.data}\n\n`),
      });
    },
  };
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe('streamExplain reconnect (5.7)', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__;
    delete window.__LSATLAB_LOCAL_API_TOKEN__;
  });
  afterEach(() => {
    delete window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__;
    delete window.__LSATLAB_LOCAL_API_TOKEN__;
    vi.restoreAllMocks();
  });

  const body = { question_id: 1, chosen_answer: 'A' as string | null };

  it('streams tokens then completes on a clean done', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          { data: JSON.stringify({ token: 'Hello ' }) },
          { data: JSON.stringify({ token: 'world' }) },
          { data: JSON.stringify({ done: true, explanation_id: 7 }) },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    let doneId: number | undefined;
    let errored = false;
    await streamExplain(body, {
      onToken: (t) => tokens.push(t),
      onDone: (id) => (doneId = id),
      onError: () => (errored = true),
    });

    expect(tokens.join('')).toBe('Hello world');
    expect(doneId).toBe(7);
    expect(errored).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('attaches the local API token to streaming explanation requests', async () => {
    window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = 'run-token';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([{ data: JSON.stringify({ done: true }) }]));
    vi.stubGlobal('fetch', fetchMock);

    await streamExplain(body, { onToken: () => {} });

    const init = fetchMock.mock.calls[0]?.[1] ?? {};
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer run-token');
  });

  it('attaches the local API token to Socratic turn streams', async () => {
    window.__STUDYVAULT_LSATLAB_LOCAL_API_TOKEN__ = 'run-token';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([{ data: JSON.stringify({ done: true }) }]));
    vi.stubGlobal('fetch', fetchMock);

    await streamSocraticTurn(77, { content: 'Why this choice?' }, { onToken: () => {} });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toContain('/api/conversations/77/turns-stream');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer run-token');
  });

  it('forwards notebook context provenance from done metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          {
            data: JSON.stringify({
              done: true,
              explanation_id: 8,
              notebook_context: {
                count: 1,
                items: [
                  {
                    kind: 'note',
                    id: 12,
                    title: 'Scope shift memo',
                    reason: 'question',
                  },
                ],
              },
            }),
          },
        ]),
      ),
    );

    let title = '';
    await streamExplain(body, {
      onToken: () => {},
      onDone: (_id, meta) => {
        title = meta?.notebook_context?.items[0]?.title ?? '';
      },
    });

    expect(title).toBe('Scope shift memo');
  });

  it('posts attempt and forwards Socratic reveal metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          data: JSON.stringify({
            done: true,
            explanation_id: null,
            socratic_context: {
              personalized: true,
              attempt_id: 42,
              conversation_id: 77,
              rationale_count: 1,
              turn_count: 2,
              trap_guess: 'correlation_causation',
            },
          }),
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    let trapGuess = '';
    await streamExplain(
      {
        question_id: 1,
        chosen_answer: 'A',
        attempt_id: 42,
        conversation_id: 77,
      },
      {
        onToken: () => {},
        onDone: (_id, meta) => {
          trapGuess = meta?.socratic_context?.trap_guess ?? '';
        },
      },
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(payload).toMatchObject({
      question_id: 1,
      chosen_answer: 'A',
      attempt_id: 42,
      conversation_id: 77,
    });
    expect(trapGuess).toBe('correlation_causation');
  });

  it('auto-reconnects after a mid-stream drop and fires onReconnect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([{ data: JSON.stringify({ token: 'partial' }) }, { throwErr: new TypeError('network error') }]),
      )
      .mockResolvedValueOnce(
        sseResponse([{ data: JSON.stringify({ token: 'full answer' }) }, { data: JSON.stringify({ done: true }) }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const reconnects: number[] = [];
    let errored = false;
    await streamExplain(body, {
      onToken: (t) => tokens.push(t),
      onReconnect: (n) => {
        reconnects.push(n);
        tokens.length = 0; // caller resets partial output
      },
      onError: () => (errored = true),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reconnects).toEqual([1]);
    expect(tokens.join('')).toBe('full answer');
    expect(errored).toBe(false);
  });

  it('does not retry an explicit abort', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    vi.stubGlobal('fetch', fetchMock);
    ctrl.abort();

    let errored = false;
    await streamExplain(body, {
      onToken: () => {},
      onError: () => (errored = true),
      signal: ctrl.signal,
    });

    // Aborted: no error surfaced and no retry storm.
    expect(errored).toBe(false);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('surfaces a definitive 4xx without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([], { ok: false, status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    let errored = false;
    await streamExplain(body, {
      onToken: () => {},
      onError: () => (errored = true),
    });

    expect(errored).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
