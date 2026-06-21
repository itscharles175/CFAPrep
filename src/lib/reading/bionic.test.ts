import { describe, expect, it } from 'vitest';
import { fixationLength, toBionicRuns } from './bionic';

describe('fixationLength — how much of a word to emphasise', () => {
  it('bolds the whole of a single-character word', () => {
    expect(fixationLength('a')).toBe(1);
  });

  it('bolds one character for short (2-3 char) words', () => {
    expect(fixationLength('to')).toBe(1);
    expect(fixationLength('the')).toBe(1);
  });

  it('bolds ~40% of longer words', () => {
    expect(fixationLength('reading')).toBe(Math.ceil(7 * 0.4)); // 3
    expect(fixationLength('accessibility')).toBe(Math.ceil(13 * 0.4)); // 6
  });

  it('never bolds the entire word for length >= 2 (always leaves a tail)', () => {
    for (const word of ['it', 'cat', 'word', 'longerword', 'antidisestablishment']) {
      expect(fixationLength(word)).toBeLessThan(word.length);
    }
  });
});

describe('toBionicRuns — splitting text into bold/plain runs', () => {
  it('returns nothing for empty input', () => {
    expect(toBionicRuns('')).toEqual([]);
  });

  it('preserves the original text verbatim when runs are reassembled', () => {
    const input = 'The quick, brown fox! (1999) — x2.';
    const runs = toBionicRuns(input);
    expect(runs.map((r) => r.text).join('')).toBe(input);
  });

  it('marks the leading fixation of each word bold and keeps separators plain', () => {
    const runs = toBionicRuns('reading');
    expect(runs).toEqual([
      { text: 'rea', bold: true },
      { text: 'ding', bold: false },
    ]);
  });

  it('treats whitespace and punctuation as non-bold separators', () => {
    const runs = toBionicRuns('a, b');
    expect(runs.some((r) => r.bold && /[,\s]/.test(r.text))).toBe(false);
  });

  it('handles unicode letters and numbers as single words', () => {
    const runs = toBionicRuns('café 2024');
    // No run should be empty and the reassembly must be lossless.
    expect(runs.every((r) => r.text.length > 0)).toBe(true);
    expect(runs.map((r) => r.text).join('')).toBe('café 2024');
  });
});
