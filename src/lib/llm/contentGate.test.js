import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUNDEDNESS_THRESHOLD,
  checkFlashcardSanity,
  checkMcqSanity,
  gateBatch,
  runContentGate,
  tokenOverlapGroundedness,
} from './contentGate';

const CONTEXT =
  'Modified duration estimates a bond price change for a 1 percentage point yield shift. ' +
  'Macaulay duration is the weighted average time to receive a bond cash flow.';

describe('checkMcqSanity', () => {
  it('passes a well-formed MCQ', () => {
    expect(
      checkMcqSanity({ question: 'What is duration?', options: ['Time', 'Price sensitivity'], correct: 1 }),
    ).toEqual([]);
  });

  it('flags fewer than two options', () => {
    const v = checkMcqSanity({ question: 'q', options: ['only one'], correct: 0 });
    expect(v.map((x) => x.code)).toContain('OPTION_COUNT');
  });

  it('flags a blank option', () => {
    const v = checkMcqSanity({ question: 'q', options: ['a', '  '], correct: 0 });
    expect(v.map((x) => x.code)).toContain('BLANK_OPTION');
  });

  it('flags duplicate options', () => {
    const v = checkMcqSanity({ question: 'q', options: ['Same', 'same'], correct: 0 });
    expect(v.map((x) => x.code)).toContain('DUP_OPTION');
  });

  it('flags "all/none of the above" meta-options', () => {
    const v = checkMcqSanity({ question: 'q', options: ['a', 'b', 'All of the above'], correct: 0 });
    expect(v.map((x) => x.code)).toContain('META_OPTION');
  });

  it('flags an out-of-range correct index', () => {
    const v = checkMcqSanity({ question: 'q', options: ['a', 'b'], correct: 5 });
    expect(v.map((x) => x.code)).toContain('BAD_CORRECT_INDEX');
  });

  it('flags an empty stem', () => {
    const v = checkMcqSanity({ question: '   ', options: ['a', 'b'], correct: 0 });
    expect(v.map((x) => x.code)).toContain('EMPTY_STEM');
  });
});

describe('checkFlashcardSanity', () => {
  it('passes a real card', () => {
    expect(checkFlashcardSanity({ front: 'Define duration', back: 'Price sensitivity to yield' })).toEqual([]);
  });
  it('flags empty front/back', () => {
    const v = checkFlashcardSanity({ front: '', back: 'x' });
    expect(v.map((x) => x.code)).toContain('EMPTY_FRONT');
  });
});

describe('tokenOverlapGroundedness', () => {
  it('scores high when content reuses source terms', () => {
    const score = tokenOverlapGroundedness('What is modified duration of a bond?', CONTEXT);
    expect(score).toBeGreaterThan(DEFAULT_GROUNDEDNESS_THRESHOLD);
  });

  it('scores low for content unrelated to the source', () => {
    const score = tokenOverlapGroundedness('Photosynthesis converts sunlight into glucose energy', CONTEXT);
    expect(score).toBeLessThan(DEFAULT_GROUNDEDNESS_THRESHOLD);
  });

  it('does not penalize when there is no context to ground against', () => {
    expect(tokenOverlapGroundedness('anything at all here', '')).toBe(1);
  });

  it('does not penalize content with no salient (assessable) tokens', () => {
    expect(tokenOverlapGroundedness('a b c', CONTEXT)).toBe(1);
  });
});

describe('runContentGate', () => {
  it('accepts a grounded, well-formed MCQ', () => {
    const result = runContentGate({
      kind: 'mcq',
      value: {
        question: 'What does modified duration estimate?',
        options: ['Bond price change for a yield shift', 'Coupon rate'],
        correct: 0,
      },
      context: CONTEXT,
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBeDefined();
  });

  it('quarantines (does not emit) an MCQ with a bad answer index', () => {
    const result = runContentGate({
      kind: 'mcq',
      value: { question: 'What is duration?', options: ['a-bond', 'b-yield'], correct: 9 },
      context: CONTEXT,
    });
    expect(result.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    expect(result.violations.map((v) => v.code)).toContain('BAD_CORRECT_INDEX');
  });

  it('quarantines an ungrounded MCQ', () => {
    const result = runContentGate({
      kind: 'mcq',
      value: {
        question: 'Which planet hosts the largest volcano in the solar system?',
        options: ['Mars Olympus', 'Venus highland'],
        correct: 0,
      },
      context: CONTEXT,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('UNGROUNDED');
  });

  it('supports a custom groundedness function (RAG-4 / GAP-ENTAIL-1 seam)', () => {
    const always0 = () => 0; // pretend entailment says "not entailed"
    const result = runContentGate({
      kind: 'mcq',
      value: { question: 'modified duration of a bond', options: ['a-x', 'b-y'], correct: 0 },
      context: CONTEXT,
      groundednessFn: always0,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('UNGROUNDED');
  });

  it('throws on an unknown kind (caller misuse)', () => {
    expect(() => runContentGate({ kind: 'bogus', value: {} })).toThrow(/unknown kind/i);
  });
});

describe('gateBatch', () => {
  it('splits a batch into accepted + quarantined buckets', () => {
    const items = [
      { question: 'What does modified duration estimate?', options: ['Bond price change', 'Coupon'], correct: 0 },
      { question: 'bad', options: ['only one'], correct: 0 }, // OPTION_COUNT
    ];
    const { accepted, quarantined } = gateBatch({ kind: 'mcq', items, context: CONTEXT });
    expect(accepted).toHaveLength(1);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].violations.length).toBeGreaterThan(0);
  });

  it('handles a non-array gracefully', () => {
    const { accepted, quarantined } = gateBatch({ kind: 'mcq', items: null, context: CONTEXT });
    expect(accepted).toEqual([]);
    expect(quarantined).toEqual([]);
  });
});
