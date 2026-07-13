import { describe, expect, it } from 'vitest';
import { parseCitations } from './citations';

describe('parseCitations', () => {
  it('returns the answer untouched when there are no source markers', () => {
    const result = parseCitations('Just a plain sentence.');
    expect(result.tokens).toEqual([{ kind: 'text', text: 'Just a plain sentence.' }]);
    expect(result.sourceIds).toEqual([]);
  });

  it('replaces a single inline source marker with a numbered cite token', () => {
    const result = parseCitations('Duration measures sensitivity [source:abc].');
    expect(result.sourceIds).toEqual(['source:abc']);
    expect(result.tokens).toEqual([
      { kind: 'text', text: 'Duration measures sensitivity ' },
      { kind: 'cite', refs: [1] },
      { kind: 'text', text: '.' },
    ]);
  });

  it('groups comma-separated sources inside one marker', () => {
    const result = parseCitations('See [source:abc, source:def] for both.');
    expect(result.sourceIds).toEqual(['source:abc', 'source:def']);
    expect(result.tokens.find((t) => t.kind === 'cite')).toEqual({ kind: 'cite', refs: [1, 2] });
  });

  it('reuses the same number when the same source id is cited again', () => {
    const result = parseCitations('A [source:abc] and again [source:abc].');
    expect(result.sourceIds).toEqual(['source:abc']);
    const cites = result.tokens.filter((t) => t.kind === 'cite');
    expect(cites).toHaveLength(2);
    expect(cites[0]).toEqual({ kind: 'cite', refs: [1] });
    expect(cites[1]).toEqual({ kind: 'cite', refs: [1] });
  });

  it('numbers source ids in order of first appearance and handles nested mentions', () => {
    const result = parseCitations('First [source:z], then [source:a, source:z], finally [source:a].');
    expect(result.sourceIds).toEqual(['source:z', 'source:a']);
    const cites = result.tokens.filter((t) => t.kind === 'cite');
    expect(cites.map((c) => (c as { refs: number[] }).refs)).toEqual([[1], [2, 1], [2]]);
  });

  it('tolerates whitespace inside the brackets', () => {
    const result = parseCitations('Spaced [ source:abc , source:def ] sources.');
    expect(result.sourceIds).toEqual(['source:abc', 'source:def']);
  });
});
