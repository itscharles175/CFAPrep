import { describe, expect, it } from 'vitest';

import { reciprocalRankFusion, textKey, type FusionItem } from './fusion';

const item = (id: string, text?: string): FusionItem => ({ id, text });

describe('RAG-6 — reciprocal-rank fusion', () => {
  it('rewards consensus: a doc near the top of two lists beats a single-list #1', () => {
    const listA = { items: [item('x'), item('a'), item('b')] }; // a at rank 2
    const listB = { items: [item('c'), item('a'), item('d')] }; // a at rank 2
    const fused = reciprocalRankFusion([listA, listB]);
    // 'a' appears in both lists → highest summed RRF.
    expect(fused[0].item.id).toBe('a');
    expect(fused[0].listHits).toBe(2);
  });

  it('a single list preserves its order exactly (host-only path invariant)', () => {
    const list = { items: [item('p'), item('q'), item('r')] };
    const fused = reciprocalRankFusion([list]);
    expect(fused.map((f) => f.item.id)).toEqual(['p', 'q', 'r']);
  });

  it('id-dedup sums contributions across lists', () => {
    const fused = reciprocalRankFusion([
      { items: [item('a')] },
      { items: [item('a')] },
    ]);
    expect(fused).toHaveLength(1);
    const k = 60;
    expect(fused[0].rrfScore).toBeCloseTo(2 * (1 / (k + 1)), 9);
  });

  it('honours per-list weight', () => {
    const fused = reciprocalRankFusion([
      { items: [item('a'), item('b')], weight: 1 },
      { items: [item('b'), item('a')], weight: 3 }, // b is rank 1 in the heavy list
    ]);
    expect(fused[0].item.id).toBe('b');
  });

  it('calibrated text-dedup collapses near-duplicate text into one representative', () => {
    const fused = reciprocalRankFusion([
      // 'a' is rank 1 in a 2-item list; 'b' (identical normalised text) is rank 2
      // in list B → 'a' has the higher RRF and is the surviving representative.
      { items: [item('a', 'Same passage here.'), item('z', 'unique text')] },
      { items: [item('q', 'other'), item('b', 'same passage here.')] },
    ]);
    const ids = fused.map((f) => f.item.id);
    expect(ids.filter((x) => x === 'a' || x === 'b')).toEqual(['a']); // only 'a' survives
    expect(ids).toContain('z');
    expect(ids).toContain('q');
  });

  it('dedupeByText:false keeps distinct ids even with identical text', () => {
    const fused = reciprocalRankFusion(
      [{ items: [item('a', 'dup'), item('b', 'dup')] }],
      { dedupeByText: false },
    );
    expect(fused).toHaveLength(2);
  });

  it('is deterministic — ties break by ascending id', () => {
    const fused = reciprocalRankFusion([{ items: [item('z'), item('a')] }, { items: [item('a'), item('z')] }]);
    // both ids get 1/(k+1) + 1/(k+2) → identical score → ascending id wins.
    expect(fused.map((f) => f.item.id)).toEqual(['a', 'z']);
  });

  it('respects limit', () => {
    const fused = reciprocalRankFusion([{ items: [item('a'), item('b'), item('c')] }], { limit: 2 });
    expect(fused).toHaveLength(2);
  });

  it('textKey normalises case + whitespace', () => {
    expect(textKey('  Hello   World  ')).toBe('hello world');
    expect(textKey(undefined)).toBe('');
  });
});
