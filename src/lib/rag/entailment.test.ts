import { describe, expect, it, vi } from 'vitest';

import {
  entail,
  lexicalEntailmentScore,
  lexicalGroundednessFn,
  salientTokens,
  DEFAULT_ENTAILMENT_THRESHOLD,
  type EntailmentGenerate,
} from './entailment';

describe('GAP-ENTAIL-1 — lexical entailment (offline, deterministic)', () => {
  it('scores full token overlap as 1 and disjoint as 0', () => {
    expect(lexicalEntailmentScore('modified duration measures bond price', 'modified duration measures the bond price sensitivity')).toBe(1);
    expect(lexicalEntailmentScore('pivot table aggregation', 'the dividend discount model values equity')).toBe(0);
  });

  it('returns a partial fraction for partial overlap', () => {
    // claim salient tokens: {convexity, captures, curvature}; evidence has convexity+curvature
    const score = lexicalEntailmentScore('convexity captures curvature', 'convexity describes the curvature');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('does not penalise when there is no evidence (returns 1)', () => {
    expect(lexicalEntailmentScore('any claim here', '')).toBe(1);
  });

  it('does not penalise a claim with no salient tokens', () => {
    expect(lexicalEntailmentScore('a an the of to', 'something entirely different content')).toBe(1);
  });

  it('salientTokens drops stopwords and <3-char tokens', () => {
    const toks = salientTokens('The bond IS a duration of 5');
    expect(toks.has('bond')).toBe(true);
    expect(toks.has('duration')).toBe(true);
    expect(toks.has('the')).toBe(false);
    expect(toks.has('is')).toBe(false);
  });

  it('lexicalGroundednessFn is the lexical score (the gate seam)', () => {
    expect(lexicalGroundednessFn('duration bond', 'duration of the bond')).toBe(
      lexicalEntailmentScore('duration bond', 'duration of the bond'),
    );
  });
});

describe('GAP-ENTAIL-1 — entail() resolution order', () => {
  it('uses the LLM judge when reachable + parseable (method:llm)', async () => {
    const generate: EntailmentGenerate = vi.fn(async () => ({ text: '90' }));
    const res = await entail('claim', 'evidence', { generate });
    expect(res.method).toBe('llm');
    expect(res.score).toBeCloseTo(0.9, 6);
    expect(res.entailed).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('clamps an out-of-range model score to [0,1]', async () => {
    const generate: EntailmentGenerate = vi.fn(async () => ({ text: '250 out of 100' }));
    const res = await entail('c', 'e', { generate });
    expect(res.score).toBe(1);
  });

  it('falls back to lexical when the LLM throws (offline) — never throws', async () => {
    const generate: EntailmentGenerate = vi.fn(async () => {
      throw new Error('Could not reach the local model server.');
    });
    const res = await entail('duration bond', 'the bond duration', { generate });
    expect(res.method).toBe('lexical');
    expect(res.score).toBe(1);
  });

  it('falls back to lexical when the LLM reply is unparseable', async () => {
    const generate: EntailmentGenerate = vi.fn(async () => ({ text: 'definitely yes' }));
    const res = await entail('convexity', 'convexity curvature', { generate });
    expect(res.method).toBe('lexical');
  });

  it('honours useLlm:false (pure offline lexical path)', async () => {
    const generate: EntailmentGenerate = vi.fn(async () => ({ text: '0' }));
    const res = await entail('duration', 'duration measure', { useLlm: false, generate });
    expect(res.method).toBe('lexical');
    expect(generate).not.toHaveBeenCalled();
  });

  it('empty claim AND evidence is trivially entailed (method:empty)', async () => {
    const res = await entail('', '', { useLlm: false });
    expect(res).toEqual({ entailed: true, score: 1, method: 'empty' });
  });

  it('respects a custom threshold', async () => {
    const generate: EntailmentGenerate = vi.fn(async () => ({ text: '40' }));
    const strict = await entail('c', 'e', { generate, threshold: 0.5 });
    const lax = await entail('c', 'e', { generate, threshold: 0.3 });
    expect(strict.entailed).toBe(false);
    expect(lax.entailed).toBe(true);
  });

  it('exposes the default threshold', () => {
    expect(DEFAULT_ENTAILMENT_THRESHOLD).toBe(0.5);
  });
});
