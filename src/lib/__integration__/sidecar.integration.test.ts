/**
 * QA-2 — host ⇄ LSAT-sidecar integration (resilience) tests.
 *
 * The unit suite (`src/lib/lsatReviewBridge.test.ts`) already covers the happy
 * path and the simple "fetch rejects" / "non-2xx" cases with a synchronous mock.
 * This file targets the harder failure modes the cross-domain Review Inbox must
 * survive in the field — a sidecar that dies *mid-request* — and asserts the REAL
 * {@link fetchLsatDue} bridge degrades to a graceful `{ ok: false }` / empty
 * result with NO throw, and that its own `AbortController` timeout actually fires.
 *
 * It drives the genuine bridge code (timeout + abort + try/catch/finally), not a
 * reimplementation: only `globalThis.fetch` is stubbed, with fakes that model the
 * sidecar going away part-way through the round-trip. The e2e counterpart
 * (`scripts/e2e-integration.mjs`) covers the live-browser + live-sidecar path; the
 * two together are QA-2's "kill the sidecar mid-request → graceful" coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLsatDue, fetchLsatDueCanonical } from '../lsatReviewBridge';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch));
}

describe('lsatReviewBridge — sidecar resilience (QA-2)', () => {
  it('degrades to { ok: false } (no throw) when the socket drops mid-request', async () => {
    // The connection is accepted but the sidecar dies before sending a body:
    // fetch rejects with a network error partway through. The bridge must catch
    // it and return the empty/degraded shape rather than propagating.
    stubFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new TypeError('network error: connection reset')), 5);
        }),
    );

    const result = await fetchLsatDue();
    expect(result.ok).toBe(false);
    expect(result.dueCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/connection reset|network error/i);
  });

  it('aborts via its own timeout when the sidecar hangs mid-request, and degrades', async () => {
    // Model a hung sidecar: it accepts the request but never responds. The only
    // thing that ends the call is the bridge's AbortController firing on its
    // timeout — so we wire the stub to reject exactly when the passed signal
    // aborts. This exercises the real timeout/abort path end-to-end.
    let observedSignal: AbortSignal | undefined;
    stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? undefined;
          observedSignal = signal ?? undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              // Browsers reject an aborted fetch with an AbortError DOMException;
              // model that so we test the same branch production hits.
              const err =
                typeof DOMException !== 'undefined'
                  ? new DOMException('The operation was aborted.', 'AbortError')
                  : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
              reject(err);
            });
          }
          // Otherwise: never resolve — only the abort ends this.
        }),
    );

    const startedAt = Date.now();
    // A short timeout keeps the test fast while still proving the real path fires.
    const result = await fetchLsatDue({ timeoutMs: 40 });
    const elapsed = Date.now() - startedAt;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(result.ok).toBe(false);
    expect(result.dueCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(typeof result.error).toBe('string');
    // It returned because the abort fired, not because the (never-resolving)
    // fetch completed — so it should be in the ballpark of the timeout, not hung.
    expect(elapsed).toBeLessThan(2000);
  });

  it('degrades when the sidecar returns 503 part-way through a recovery/restart', async () => {
    // A sidecar mid-restart (BA1 auto-restart) commonly answers 503 briefly. The
    // bridge must surface that as a degraded result carrying the status, not throw.
    stubFetch(() => Promise.resolve(new Response('service unavailable', { status: 503 })));

    const result = await fetchLsatDue();
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/503/);
  });

  it('degrades when the sidecar sends a truncated/garbage body (parse fails mid-stream)', async () => {
    // A sidecar killed while streaming JSON yields a 200 with an unparseable body.
    // res.json() throws inside the try; the bridge's catch must still degrade.
    stubFetch(() =>
      Promise.resolve(
        new Response('{"due_count": 3, "cards": [{"card_id": 1', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await fetchLsatDue();
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(typeof result.error).toBe('string');
  });

  it('canonical wrapper degrades to { ok: false, cards: [] } on the same mid-request drop', async () => {
    // fetchLsatDueCanonical is the unified-vocabulary wrapper the cross-domain
    // "what's due everywhere" caller uses; it must degrade just as gracefully.
    stubFetch(() => Promise.reject(new Error('ECONNRESET')));

    const result = await fetchLsatDueCanonical();
    expect(result.ok).toBe(false);
    expect(result.dueCount).toBe(0);
    expect(result.cards).toEqual([]);
    expect(result.error).toMatch(/ECONNRESET/);
  });

  it('recovers cleanly on the next call once the sidecar comes back', async () => {
    // Resilience also means no sticky failure: after a drop, a subsequent healthy
    // response must populate again (the bridge holds no cross-call error state).
    let attempt = 0;
    stubFetch(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            due_count: 2,
            cards: [
              { card_id: 1, question_id: 10, stem: 'Which one of the following...', q_type: 'Weaken' },
              { card_id: 2, question_id: 11, prompt: 'The argument assumes...', q_type: 'NecessaryAssumption' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    const down = await fetchLsatDue();
    expect(down.ok).toBe(false);
    expect(down.items).toEqual([]);

    const up = await fetchLsatDue();
    expect(up.ok).toBe(true);
    expect(up.dueCount).toBe(2);
    expect(up.items).toHaveLength(2);
    expect(up.items[0].domain).toBe('lsat');
  });
});
