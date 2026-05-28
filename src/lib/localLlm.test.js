import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LLM_SETTINGS,
  LLM_PRESETS,
  checkLlmConnection,
  critiqueConstructedResponse,
  explainWrongAnswer,
  generateFlashcardsFromCurriculum,
  generateQuestionsFromCurriculum,
  getLlmSettings,
  narrateStudyPlan,
  saveLlmSettings,
} from './localLlm';
import { db } from './progressStore';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Local LLM settings + connection', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.settings.clear();
  });

  it('exports presets for LM Studio and Ollama on their default ports', () => {
    const byLabel = Object.fromEntries(LLM_PRESETS.map((p) => [p.label, p.baseUrl]));
    expect(byLabel['LM Studio']).toBe('http://localhost:1234/v1');
    expect(byLabel.Ollama).toBe('http://localhost:11434/v1');
  });

  it('defaults to disabled with the Ollama URL', async () => {
    expect(DEFAULT_LLM_SETTINGS.enabled).toBe(false);
    expect((await getLlmSettings()).baseUrl).toBe('http://localhost:11434/v1');
  });

  it('persists settings and merges over the defaults', async () => {
    const saved = await saveLlmSettings({ enabled: true, baseUrl: 'http://localhost:1234/v1' });
    expect(saved.enabled).toBe(true);
    expect(saved.model).toBe('llama3.1'); // default kept
    const loaded = await getLlmSettings();
    expect(loaded.baseUrl).toBe('http://localhost:1234/v1');
  });

  it('checkLlmConnection parses the OpenAI-compatible /models list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gemma-4-e4b-it' }, { id: 'nomic-embed' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await checkLlmConnection({ baseUrl: 'http://localhost:1234/v1/' });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gemma-4-e4b-it', 'nomic-embed']);
  });

  it('checkLlmConnection surfaces a non-200 status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    const result = await checkLlmConnection({ baseUrl: 'http://localhost:1234/v1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });
});

describe('generateQuestionsFromCurriculum', () => {
  afterEach(() => vi.restoreAllMocks());

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  const chunks = [
    { locator: 'p.10', text: 'Modified duration estimates a bond price change for a 1pp yield shift.' },
    { locator: 'p.11', text: 'Macaulay duration is the weighted average time to receive cash flows.' },
  ];

  it('parses a fenced JSON array of MCQs and normalizes question shape', async () => {
    const modelOutput = '```json\n[\n  { "question": "What is duration?", "options": ["Time", "Price sensitivity", "Coupon"], "correct": 1, "explanation": "Duration measures price sensitivity." },\n  { "question": "Macaulay vs modified?", "options": ["Same", "Different"], "correct": 1, "explanation": "Modified divides by (1+YTM)." }\n]\n```';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: modelOutput } }] })));

    const questions = await generateQuestionsFromCurriculum({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
      topicTitle: 'Fixed Income',
      chunks,
      count: 2,
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ id: 'ai-1', question: 'What is duration?', correct: 1 });
    expect(questions[0].options).toHaveLength(3);
    expect(questions[1].id).toBe('ai-2');
  });

  it('clamps an out-of-range `correct` index to 0', async () => {
    const modelOutput = '[{"question":"q","options":["a","b"],"correct":7,"explanation":""}]';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: modelOutput } }] })));
    const questions = await generateQuestionsFromCurriculum({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      topicTitle: 'X',
      chunks,
      count: 1,
    });
    expect(questions[0].correct).toBe(0);
  });

  it('drops malformed items and throws when nothing parses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'not json at all' } }] })));
    await expect(
      generateQuestionsFromCurriculum({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        topicTitle: 'X',
        chunks,
        count: 2,
      }),
    ).rejects.toThrow(/parseable/);
  });

  it('refuses to call the model when no chunks are supplied', async () => {
    await expect(
      generateQuestionsFromCurriculum({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        topicTitle: 'X',
        chunks: [],
        count: 2,
      }),
    ).rejects.toThrow(/No curriculum text/);
  });

  it('truncates the context to keep prompts under the model window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '[{"question":"q","options":["a","b"],"correct":0}]' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const giantChunks = Array.from({ length: 200 }, (_, i) => ({ locator: `p.${i}`, text: 'x'.repeat(200) }));
    await generateQuestionsFromCurriculum({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      topicTitle: 'X',
      chunks: giantChunks,
      count: 1,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMessage = body.messages.find((m) => m.role === 'user').content;
    // Context sliced to <= 12000 chars per the helper.
    expect(userMessage.length).toBeLessThan(20_000);
  });
});

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

describe('critiqueConstructedResponse', () => {
  afterEach(() => vi.restoreAllMocks());

  const rubric = [
    { id: 'c1', label: 'Asset allocation rationale', maxPoints: 3 },
    { id: 'c2', label: 'Risk factor identification', maxPoints: 2, description: 'Name at least two risk factors.' },
  ];

  it('posts a chat completion with model, low temperature, system + user messages containing the prompt, response, and a Criterion block per rubric entry with maxPoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'c1: Partial — candidate mentions equities but omits fixed income.\nc2: Missed — no risk factors named.' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await critiqueConstructedResponse({
      settings: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
      prompt: 'Recommend an asset allocation for a 60-year-old retiree.',
      response: 'I would allocate 70% equities for growth.',
      rubric,
    });

    expect(result).toContain('c1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gemma-4-e4b-it');
    expect(body.temperature).toBeLessThanOrEqual(0.2);

    const systemMessage = body.messages.find((m) => m.role === 'system').content;
    expect(systemMessage).toContain('rubric grader');

    const userMessage = body.messages.find((m) => m.role === 'user').content;
    expect(userMessage).toContain('Recommend an asset allocation');
    expect(userMessage).toContain('70% equities');
    // One block per rubric entry with the label and maxPoints
    expect(userMessage).toContain('Asset allocation rationale');
    expect(userMessage).toContain('3 pt');
    expect(userMessage).toContain('Risk factor identification');
    expect(userMessage).toContain('2 pt');
  });

  it('returns the model content string trimmed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '  c1: Met — candidate clearly outlines the rationale.  \n' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await critiqueConstructedResponse({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      prompt: 'Describe IPS construction.',
      response: 'An IPS defines objectives and constraints.',
      rubric,
    });

    expect(result).toBe('c1: Met — candidate clearly outlines the rationale.');
  });

  it('network failure rejects with the CORS-actionable wrapped error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      critiqueConstructedResponse({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        prompt: 'p',
        response: 'r',
        rubric,
      }),
    ).rejects.toThrow(/CORS|OLLAMA_ORIGINS/);
  });
});

describe('narrateStudyPlan', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the plan with action list + counts and returns the model prose', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Start with the modified-duration review while it is still fresh...\n\nSuccess looks like...' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const text = await narrateStudyPlan({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
      plan: {
        headline: '2 reviews due, 1 weak topic',
        dueCount: 2,
        weakCount: 1,
        peakReviewDay: { date: '2026-05-30', count: 9 },
        actions: [
          { kind: 'review', title: 'Duration', reason: '42% retention' },
          { kind: 'weak-topic', title: 'Equity', reason: '58% readiness' },
        ],
      },
    });
    expect(text).toContain('modified-duration');
    const userMessage = JSON.parse(fetchMock.mock.calls[0][1].body).messages.find((m) => m.role === 'user').content;
    expect(userMessage).toContain('[review] Duration');
    expect(userMessage).toContain('[weak-topic] Equity');
    expect(userMessage).toContain('2026-05-30');
  });

  it('rejects an empty model response with a friendly error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '   ' } }] })));
    await expect(
      narrateStudyPlan({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        plan: { headline: 'x', actions: [{ kind: 'continue', title: 'go', reason: 'idle' }] },
      }),
    ).rejects.toThrow(/empty narrative/);
  });
});

describe('generateFlashcardsFromCurriculum', () => {
  afterEach(() => vi.restoreAllMocks());

  const chunks = [
    { locator: 'p.10', text: 'Modified duration estimates a bond price change for a 1pp yield shift.' },
    { locator: 'p.11', text: 'Macaulay duration is the weighted average time to receive cash flows.' },
  ];

  it('posts a chat completion with model + low temp; parses a fenced JSON array of {front,back,locator}; returns objects with sequential flash-N ids', async () => {
    const modelOutput =
      '```json\n[\n' +
      '  { "front": "What is modified duration?", "back": "It estimates bond price change for a 1pp yield shift.", "locator": "p.10" },\n' +
      '  { "front": "Define Macaulay duration.", "back": "The weighted average time to receive cash flows.", "locator": "p.11" }\n' +
      ']\n```';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: modelOutput } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cards = await generateFlashcardsFromCurriculum({
      settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma-4-e4b-it' },
      topicTitle: 'Fixed Income',
      chunks,
      count: 6,
    });

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: 'flash-1', front: 'What is modified duration?', locator: 'p.10' });
    expect(cards[1].id).toBe('flash-2');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gemma-4-e4b-it');
    expect(body.temperature).toBeLessThanOrEqual(0.3);
  });

  it('refuses to call the model when no chunks are supplied', async () => {
    await expect(
      generateFlashcardsFromCurriculum({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        topicTitle: 'X',
        chunks: [],
        count: 6,
      }),
    ).rejects.toThrow(/No curriculum text/);
  });

  it('network failure rejects with the CORS-actionable wrapped error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(
      generateFlashcardsFromCurriculum({
        settings: { baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
        topicTitle: 'X',
        chunks,
        count: 6,
      }),
    ).rejects.toThrow(/CORS|OLLAMA_ORIGINS/);
  });
});
