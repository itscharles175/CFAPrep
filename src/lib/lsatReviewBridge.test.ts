import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLsatDue, LSAT_REVIEW_PATH } from './lsatReviewBridge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch));
}

describe('fetchLsatDue', () => {
  it('maps the sidecar due payload into unified items', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            due_count: 3,
            cards: [
              { card_id: 1, question_id: 10, stem: 'Which one of the following...', q_type: 'Weaken' },
              { card_id: 2, question_id: 11, prompt: 'The argument assumes that...', q_type: 'NecessaryAssumption' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const result = await fetchLsatDue();
    expect(result.ok).toBe(true);
    expect(result.dueCount).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ domain: 'lsat', deepLinkPath: LSAT_REVIEW_PATH, qType: 'Weaken' });
    expect(result.items[0].title).toContain('Which one');
  });

  it('respects the limit (default 5)', async () => {
    const cards = Array.from({ length: 12 }, (_, i) => ({ card_id: i, stem: `Item ${i}` }));
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ due_count: 12, cards }), { status: 200 })));
    const result = await fetchLsatDue({ limit: 4 });
    expect(result.ok).toBe(true);
    expect(result.dueCount).toBe(12);
    expect(result.items).toHaveLength(4);
  });

  it('truncates long stems', async () => {
    const longStem = 'x'.repeat(200);
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ due_count: 1, cards: [{ card_id: 1, stem: longStem }] }), { status: 200 })));
    const result = await fetchLsatDue();
    expect(result.items[0].title.length).toBeLessThanOrEqual(80);
    expect(result.items[0].title.endsWith('…')).toBe(true);
  });

  it('returns ok:false on a non-2xx response (no throw)', async () => {
    mockFetch(() => Promise.resolve(new Response('nope', { status: 503 })));
    const result = await fetchLsatDue();
    expect(result.ok).toBe(false);
    expect(result.dueCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/503/);
  });

  it('returns ok:false when the sidecar is unreachable (fetch throws)', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await fetchLsatDue();
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('falls back to cards.length when due_count is absent', async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ cards: [{ card_id: 1 }, { card_id: 2 }] }), { status: 200 })));
    const result = await fetchLsatDue();
    expect(result.ok).toBe(true);
    expect(result.dueCount).toBe(2);
  });
});
