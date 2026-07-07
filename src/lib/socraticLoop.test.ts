import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the voice module BEFORE importing socraticLoop so its imports resolve
// to the mocked exports.
vi.mock('./voice', () => {
  const recognizeOnce = vi.fn();
  const speak = vi.fn(async () => undefined);
  const stopSpeaking = vi.fn();
  const sanitizeForSpeech = (s: string) => s;
  const hasSpeechRecognition = vi.fn(() => true);
  const hasSpeechSynthesis = vi.fn(() => true);
  return {
    recognizeOnce,
    speak,
    stopSpeaking,
    sanitizeForSpeech,
    hasSpeechRecognition,
    hasSpeechSynthesis,
  };
});

vi.mock('./localLlm', () => ({
  generateText: vi.fn(),
}));

import { openSocraticSession } from './socraticLoop';
import * as voice from './voice';
import * as llm from './localLlm';

const recognizeOnceMock = voice.recognizeOnce as unknown as ReturnType<typeof vi.fn>;
const speakMock = voice.speak as unknown as ReturnType<typeof vi.fn>;
const generateTextMock = llm.generateText as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  recognizeOnceMock.mockReset();
  speakMock.mockReset();
  speakMock.mockResolvedValue(undefined);
  generateTextMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('openSocraticSession', () => {
  it('runs one full turn: listen → think → speak → idle', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'What is duration?', engine: 'browser-native' });
    generateTextMock.mockResolvedValueOnce({ text: 'Duration measures a bond\'s price sensitivity. How does that change with coupon size?' });

    const session = openSocraticSession();
    const result = await session.next();

    expect(result.ended).toBe(false);
    expect(session.history).toHaveLength(1);
    expect(session.history[0].user).toBe('What is duration?');
    expect(session.history[0].coach).toContain('Duration');
    expect(session.state).toBe('idle');
    expect(speakMock).toHaveBeenCalled();
  });

  it('strips reasoning traces before storing or speaking a coach turn', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'Coach me on convexity.', engine: 'browser-native' });
    generateTextMock.mockResolvedValueOnce({ text: '<think>private plan</think>Convexity is curvature in the bond price-yield relationship.' });

    const session = openSocraticSession();
    const result = await session.next();

    expect(result.ended).toBe(false);
    expect(session.history[0].coach).toBe('Convexity is curvature in the bond price-yield relationship.');
    expect(speakMock).toHaveBeenCalledWith(
      'Convexity is curvature in the bond price-yield relationship.',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ends on the default stop phrase "end session"', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'OK, end session please.', engine: 'browser-native' });

    const session = openSocraticSession();
    const result = await session.next();

    expect(result.ended).toBe(true);
    expect(result.reason).toBe('user-stopped');
    // No LLM call when stop-phrase fires.
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(speakMock).not.toHaveBeenCalled();
  });

  it('honours custom stop phrases', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'mute the coach now', engine: 'browser-native' });

    const session = openSocraticSession({ stopPhrases: ['mute the coach'] });
    const result = await session.next();

    expect(result.ended).toBe(true);
    expect(result.reason).toBe('user-stopped');
  });

  it('returns ended on empty transcript', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: '   ', engine: 'browser-native' });

    const session = openSocraticSession();
    const result = await session.next();

    expect(result.ended).toBe(true);
    expect(result.reason).toBe('empty-transcript');
  });

  it('returns ended on STT failure', async () => {
    recognizeOnceMock.mockRejectedValueOnce(new Error('mic permission denied'));

    const session = openSocraticSession();
    const result = await session.next();

    expect(result.ended).toBe(true);
    expect(result.reason).toContain('mic permission denied');
  });

  it('returns ended on LLM failure', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'Tell me about NPV', engine: 'browser-native' });
    generateTextMock.mockRejectedValueOnce(new Error('local model server down'));

    const session = openSocraticSession();
    const result = await session.next();

    expect(result.ended).toBe(true);
    expect(result.reason).toContain('local model server down');
  });

  it('builds transcript with up to maxTurns of history', async () => {
    const session = openSocraticSession({ maxTurns: 2 });

    // Run 3 turns to exceed the window.
    for (let i = 0; i < 3; i++) {
      recognizeOnceMock.mockResolvedValueOnce({ transcript: `question ${i}`, engine: 'browser-native' });
      generateTextMock.mockResolvedValueOnce({ text: `answer ${i}` });
      await session.next();
    }

    // 4th turn should only carry the last 2 turns.
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'question 4', engine: 'browser-native' });
    generateTextMock.mockResolvedValueOnce({ text: 'answer 4' });
    await session.next();

    const lastCall = generateTextMock.mock.calls[3][0];
    expect(lastCall.prompt).toContain('Student: question 1');
    expect(lastCall.prompt).toContain('Student: question 2');
    expect(lastCall.prompt).toContain('Student: question 4');
    expect(lastCall.prompt).not.toContain('Student: question 0');
  });

  it('prepends grounding excerpts to the system prompt', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'why?', engine: 'browser-native' });
    generateTextMock.mockResolvedValueOnce({ text: 'Because.' });

    const session = openSocraticSession({
      groundingExcerpts: ['NPV is the present value of future cash flows.'],
    });
    await session.next();

    const call = generateTextMock.mock.calls[0][0];
    expect(call.system).toContain('NPV is the present value');
  });

  it('emits state transitions', async () => {
    recognizeOnceMock.mockResolvedValueOnce({ transcript: 'hi', engine: 'browser-native' });
    generateTextMock.mockResolvedValueOnce({ text: 'hello' });

    const session = openSocraticSession();
    const states: string[] = [];
    session.onState((s) => states.push(s));

    await session.next();

    expect(states).toEqual(expect.arrayContaining(['listening', 'thinking', 'speaking', 'idle']));
  });

  it('stop() cancels in-flight work', async () => {
    let resolveStt: (v: { transcript: string; engine: string }) => void = () => {};
    recognizeOnceMock.mockReturnValueOnce(new Promise((res) => { resolveStt = res; }));

    const session = openSocraticSession();
    const pending = session.next();

    session.stop();
    resolveStt({ transcript: 'late', engine: 'browser-native' });

    const result = await pending;
    expect(result.ended).toBe(true);
  });

  it('falls back when SpeechRecognition is unavailable', async () => {
    (voice.hasSpeechRecognition as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const session = openSocraticSession();
    const result = await session.next();
    expect(result.ended).toBe(true);
    expect(result.reason).toBe('no-speech-recognition');
  });
});
