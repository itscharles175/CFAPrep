import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLsatDue, fetchUnifiedDue, LSAT_REVIEW_PATH } from './lsatReviewBridge';

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

describe('fetchUnifiedDue', () => {
  // The LEARN-2 route already returns canonical CrossDomainReviewCards (with the
  // overdueSeconds / utilityScore ranking signals), so the bridge maps each
  // straight onto a UnifiedReviewItem carrying that canonical card.
  it('maps the unified canonical payload into unified items', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            due_count: 2,
            items: [
              {
                crossId: 'lsat:review:7',
                domain: 'lsat',
                questionCrossId: 'lsat:question:42',
                title: 'Which one of the following weakens...',
                difficulty: 'advanced',
                empiricalDifficulty: 4.2,
                dueAt: '2026-06-15T09:00:00+00:00',
                itemType: 'Weaken',
                origin: 'concept_gap',
                overdueSeconds: 7200,
                utilityScore: 0.61,
              },
              {
                crossId: 'lsat:review:8',
                domain: 'lsat',
                questionCrossId: 'lsat:question:43',
                title: 'The argument assumes that...',
                difficulty: 'intermediate',
                itemType: 'NecessaryAssumption',
                overdueSeconds: 60,
                utilityScore: 0.61,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const result = await fetchUnifiedDue();
    expect(result.ok).toBe(true);
    expect(result.dueCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      domain: 'lsat',
      id: '7',
      deepLinkPath: LSAT_REVIEW_PATH,
      qType: 'Weaken',
      title: 'Which one of the following weakens...',
    });
    // The canonical card the backend sent rides along verbatim for ranking/merge.
    expect(result.items[0].canonical).toMatchObject({
      crossId: 'lsat:review:7',
      domain: 'lsat',
      questionCrossId: 'lsat:question:42',
      difficulty: 'advanced',
      empiricalDifficulty: 4.2,
      itemType: 'Weaken',
      origin: 'concept_gap',
    });
  });

  it('respects the limit (default 5)', async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      crossId: `lsat:review:${i}`,
      domain: 'lsat',
      questionCrossId: `lsat:question:${i}`,
      title: `Item ${i}`,
      difficulty: 'intermediate',
    }));
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ ok: true, due_count: 9, items }), { status: 200 })));
    const result = await fetchUnifiedDue({ limit: 3 });
    expect(result.ok).toBe(true);
    expect(result.dueCount).toBe(9);
    expect(result.items).toHaveLength(3);
  });

  it('degrades to ok:false (empty, no throw) when the sidecar is unreachable', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await fetchUnifiedDue();
    expect(result.ok).toBe(false);
    expect(result.dueCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns ok:false on a non-2xx response (no throw)', async () => {
    mockFetch(() => Promise.resolve(new Response('nope', { status: 503 })));
    const result = await fetchUnifiedDue();
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/503/);
  });

  it('falls back to items.length when due_count is absent', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              { crossId: 'lsat:review:1', questionCrossId: 'lsat:question:1', title: 'A', difficulty: 'foundation' },
              { crossId: 'lsat:review:2', questionCrossId: 'lsat:question:2', title: 'B', difficulty: 'foundation' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await fetchUnifiedDue();
    expect(result.ok).toBe(true);
    expect(result.dueCount).toBe(2);
  });

  it('degrades a partial / drifted row instead of throwing', async () => {
    // A row missing crossId / questionCrossId / difficulty must still produce a
    // valid UnifiedReviewItem with safe defaults (the inbox renders it).
    mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, due_count: 1, items: [{ title: 'Orphan card' }] }), { status: 200 })),
    );
    const result = await fetchUnifiedDue();
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.domain).toBe('lsat');
    expect(item.deepLinkPath).toBe(LSAT_REVIEW_PATH);
    expect(item.title).toBe('Orphan card');
    expect(item.canonical.difficulty).toBe('intermediate');
    expect(item.canonical.crossId).toMatch(/^lsat:review:/);
    expect(item.canonical.questionCrossId).toMatch(/^lsat:question:/);
  });
});
