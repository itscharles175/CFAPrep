import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainWrongAnswer } from './localLlm';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('explainWrongAnswer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts a chat completion with the question, options, picked, and correct letters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Because B uses Macaulay scaling that ignores the YTM denominator.' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const explanation = await explainWrongAnswer({
      settings: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
      question: 'What is modified duration?',
      options: ['A measure of credit risk', 'Macaulay duration', '(Macaulay duration)/(1 + YTM)', 'Yield to maturity'],
      correctIndex: 2,
      userIndex: 1,
      baseExplanation: 'Modified duration adjusts Macaulay duration for yield.',
    });
    expect(explanation).toContain('Macaulay');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gemma-4-e4b-it');
    expect(body.temperature).toBeLessThan(0.5);
    const userMessage = body.messages.find((m) => m.role === 'user').content;
    expect(userMessage).toContain('What is modified duration?');
    expect(userMessage).toContain('Correct answer: C');
    expect(userMessage).toContain('Student picked: B');
    expect(userMessage).toContain('Modified duration adjusts Macaulay duration for yield.');
  });

  it('turns a network failure into the actionable CORS error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      explainWrongAnswer({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        question: 'q', options: ['a', 'b', 'c'], correctIndex: 0, userIndex: 1,
      }),
    ).rejects.toThrow(/CORS|OLLAMA_ORIGINS/);
  });

  it('rejects when the model returns an empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '   ' } }] })));
    await expect(
      explainWrongAnswer({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        question: 'q', options: ['a', 'b', 'c'], correctIndex: 0, userIndex: 1,
      }),
    ).rejects.toThrow(/empty explanation/);
  });
});
