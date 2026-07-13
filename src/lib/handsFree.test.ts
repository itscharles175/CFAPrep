/**
 * A11Y-3 — handsFree core logic tests.
 *
 * Covers the spoken-transcript → option-index matcher (the safety-critical part:
 * never guess wrong, never auto-commit) and the read-aloud script builder, plus
 * the engine's cancellation/abort handling. TTS/STT are mocked.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HandsFreeEngine,
  buildReadAloudScript,
  matchSpokenAnswer,
  type VoiceOption,
} from './handsFree';

const OPTIONS: VoiceOption[] = [
  { letter: 'A', text: 'Increase the discount rate' },
  { letter: 'B', text: 'Decrease the discount rate' },
  { letter: 'C', text: 'Hold rates constant' },
  { letter: 'D', text: 'Sell the bond at par' },
];

describe('matchSpokenAnswer', () => {
  it('matches a cued letter ("option B")', () => {
    const m = matchSpokenAnswer('I think the answer is option B', OPTIONS);
    expect(m.index).toBe(1);
    expect(m.reason).toBe('letter');
    expect(m.confidence).toBe(1);
  });

  it('matches a bare single-letter transcript', () => {
    expect(matchSpokenAnswer('C', OPTIONS).index).toBe(2);
    expect(matchSpokenAnswer('d', OPTIONS).index).toBe(3);
  });

  it('does not misread the article "a" mid-sentence as option A', () => {
    // "a" appears as an article but no real letter/ordinal/text cue → no match.
    const m = matchSpokenAnswer('this is a tricky one', OPTIONS);
    expect(m.index).toBe(-1);
    expect(m.reason).toBe('none');
  });

  it('matches ordinals ("the first one", "number three")', () => {
    expect(matchSpokenAnswer('the first one', OPTIONS).index).toBe(0);
    expect(matchSpokenAnswer('number three please', OPTIONS).index).toBe(2);
    expect(matchSpokenAnswer('option two', OPTIONS).index).toBe(1);
  });

  it('falls back to fuzzy text containment', () => {
    const m = matchSpokenAnswer('I would sell the bond at par', OPTIONS);
    expect(m.index).toBe(3);
    expect(m.reason).toBe('text');
  });

  it('returns no-match for an empty or unrelated transcript', () => {
    expect(matchSpokenAnswer('', OPTIONS).index).toBe(-1);
    expect(matchSpokenAnswer('purple monkey dishwasher', OPTIONS).index).toBe(-1);
  });

  it('returns no-match when there are no options', () => {
    expect(matchSpokenAnswer('option A', []).index).toBe(-1);
  });
});

describe('buildReadAloudScript', () => {
  it('strips citations and announces each option with its letter', () => {
    const script = buildReadAloudScript({
      question: 'What is the NPV? [source:abc123]',
      options: [
        { letter: 'A', text: 'Positive [source:x]' },
        { letter: 'B', text: 'Negative' },
      ],
      preface: 'Question 1 of 2.',
    });
    expect(script).not.toContain('[source:');
    expect(script).toContain('Question 1 of 2');
    expect(script).toContain('Option A. Positive');
    expect(script).toContain('Option B. Negative');
  });
});

describe('HandsFreeEngine', () => {
  it('reads a script via the injected speak fn', async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const engine = new HandsFreeEngine({ speak });
    await engine.read('hello world');
    expect(speak).toHaveBeenCalledWith('hello world', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('does not call speak for an empty script', async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    await new HandsFreeEngine({ speak }).read('   ');
    expect(speak).not.toHaveBeenCalled();
  });

  it('swallows AbortError from a cancelled read', async () => {
    const speak = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(new HandsFreeEngine({ speak }).read('x')).resolves.toBeUndefined();
  });

  it('listens and resolves a matched index + transcript', async () => {
    const recognize = vi.fn().mockResolvedValue({ transcript: 'option C' });
    const engine = new HandsFreeEngine({ recognize });
    const result = await engine.listenForAnswer(OPTIONS);
    expect(result.index).toBe(2);
    expect(result.transcript).toBe('option C');
  });

  it('cancelAll aborts an in-flight recognition', async () => {
    let captured: AbortSignal | undefined;
    const recognize = vi.fn(
      (opts?: { signal?: AbortSignal }) =>
        new Promise<{ transcript: string }>((_, reject) => {
          captured = opts?.signal;
          opts?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const engine = new HandsFreeEngine({ recognize });
    const pending = engine.listenForAnswer(OPTIONS);
    engine.cancelAll();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(captured?.aborted).toBe(true);
  });
});
