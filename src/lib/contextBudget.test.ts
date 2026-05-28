import { describe, expect, it } from 'vitest';
import { estimateTokens, packExcerpts, pickBudget, renderExcerpts } from './contextBudget';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is monotonic with input length', () => {
    const short = estimateTokens('abc');
    const long = estimateTokens('abc'.repeat(100));
    expect(long).toBeGreaterThan(short);
  });

  it('charges extra for code-block fences', () => {
    const plain = estimateTokens('Hello world');
    const fenced = estimateTokens('Hello world\n```\ncode\n```');
    expect(fenced).toBeGreaterThan(plain + 2); // fence + content
  });

  it('charges extra for URLs', () => {
    const plain = estimateTokens('See the docs page.');
    const linked = estimateTokens('See https://example.com/some/deep/path.');
    expect(linked).toBeGreaterThan(plain);
  });

  it('estimates are conservative (overcount, not undercount)', () => {
    // Real tokenizers usually yield <0.3 tokens/char for English prose.
    const text = 'The quick brown fox jumps over the lazy dog.';
    const est = estimateTokens(text);
    expect(est).toBeGreaterThanOrEqual(Math.ceil(text.length * 0.25));
  });
});

describe('pickBudget', () => {
  it('respects an explicit override', () => {
    const b = pickBudget({ contextWindow: 16384 });
    expect(b.total).toBe(16384);
    expect(b.forUserAndGrounding).toBeLessThan(b.total);
    expect(b.reservedForResponse).toBeGreaterThan(0);
  });

  it('infers from -cw suffix in model name', () => {
    const b = pickBudget({ modelName: 'gemma-4-e4b-it-cw32768' });
    expect(b.total).toBe(32768);
  });

  it('infers from -ctx suffix in model name', () => {
    const b = pickBudget({ modelName: 'qwen-7b-instruct-ctx131072' });
    expect(b.total).toBe(131072);
  });

  it('infers from 128k friendly hint', () => {
    const b = pickBudget({ modelName: 'something-128k' });
    expect(b.total).toBe(131072);
  });

  it('falls back to 32768 when name yields no hint', () => {
    const b = pickBudget({ modelName: 'mystery-model' });
    expect(b.total).toBe(32768);
  });

  it('reserves at most 8192 tokens for the response', () => {
    const b = pickBudget({ contextWindow: 200_000 });
    expect(b.reservedForResponse).toBeLessThanOrEqual(8192);
  });

  it('clamps tiny windows up to 2048', () => {
    const b = pickBudget({ contextWindow: 100 });
    expect(b.total).toBe(2048);
    expect(b.forUserAndGrounding).toBeGreaterThanOrEqual(512);
  });
});

describe('packExcerpts', () => {
  it('returns everything when under budget', () => {
    const items = ['a', 'b', 'c'];
    const result = packExcerpts(items, 1000, (x) => x);
    expect(result.kept).toEqual(['a', 'b', 'c']);
    expect(result.dropped).toEqual([]);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('drops from the end when over budget', () => {
    const items = ['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100)];
    // ~28 tokens per 100 chars; budget for ~one of them.
    const result = packExcerpts(items, 35, (x) => x);
    expect(result.kept.length).toBe(1);
    expect(result.dropped.length).toBe(2);
  });

  it('handles empty input', () => {
    const result = packExcerpts<string>([], 1000, (x) => x);
    expect(result.kept).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
  });

  it('uses the textOf callback', () => {
    const items = [{ id: 1, body: 'short' }, { id: 2, body: 'x'.repeat(500) }];
    const result = packExcerpts(items, 20, (x) => x.body);
    expect(result.kept).toEqual([{ id: 1, body: 'short' }]);
    expect(result.dropped[0].id).toBe(2);
  });
});

describe('renderExcerpts', () => {
  it('prefixes each excerpt with its locator', () => {
    const items = [{ loc: 'p.12', text: 'The bond was BBB-rated.' }];
    const out = renderExcerpts(items, (x) => x.loc, (x) => x.text);
    expect(out).toBe('[p.12] The bond was BBB-rated.');
  });

  it('omits the prefix when locator is missing', () => {
    const items = [{ text: 'No source.' }] as Array<{ loc?: string; text: string }>;
    const out = renderExcerpts(items, (x) => x.loc, (x) => x.text);
    expect(out).toBe('No source.');
  });

  it('joins multiple excerpts with double newlines', () => {
    const items = [
      { loc: 'a', text: 'one' },
      { loc: 'b', text: 'two' },
    ];
    expect(renderExcerpts(items, (x) => x.loc, (x) => x.text)).toBe('[a] one\n\n[b] two');
  });
});
