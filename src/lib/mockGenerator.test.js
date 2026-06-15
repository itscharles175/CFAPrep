import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./localLlm', () => ({
  generateQuestionsFromCurriculum: vi.fn(),
}));
vi.mock('./cfaSourceVault', () => ({
  getCfaSourceReadingForTopic: vi.fn(),
}));

import { generateQuestionsFromCurriculum } from './localLlm';
import { getCfaSourceReadingForTopic } from './cfaSourceVault';
import {
  MOCK_BLUEPRINTS,
  gateGeneratedQuestion,
  generateMockExam,
  getCachedGeneratedMock,
  saveCachedGeneratedMock,
  toSyntheticMockContent,
} from './mockGenerator';
import { db } from './progressStore';

function q(text, correct = 0) {
  return { question: text, options: ['A', 'B', 'C'], correct, explanation: 'because' };
}

/** Stub the global fetch with a single JSON response for the gate endpoint. */
function stubGateFetch(report, { status = 200 } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(report), { status }))),
  );
}

describe('mockGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await db.settings.clear();
    vi.unstubAllGlobals();
  });

  it('exposes a blueprint per level', () => {
    expect(MOCK_BLUEPRINTS.level1.perTopic).toBeGreaterThan(0);
    expect(Object.keys(MOCK_BLUEPRINTS)).toEqual(['level1', 'level2', 'level3']);
  });

  it('shapes a generated mock into runner-ready content without truncating', () => {
    const generated = {
      level: 'level2',
      title: 'Generated Level II Mock',
      questions: [
        { ...q('q1'), id: 'gen-equity-1', topic: 'equity', topicTitle: 'Equity' },
        { ...q('q2'), id: 'gen-equity-2', topic: 'equity', topicTitle: 'Equity' },
        { ...q('q3'), id: 'gen-fi-1', topic: 'fixed-income', topicTitle: 'Fixed Income' },
      ],
    };
    const view = toSyntheticMockContent(generated);
    expect(view.levelContent.topics).toHaveLength(2);
    expect(view.mock.questionIds).toHaveLength(3);
    // every question becomes a standalone item — no level-specific slicing
    expect(view.items).toHaveLength(3);
    expect(view.items.every((item) => item.type === 'question')).toBe(true);
    expect(view.mock.vignetteIds).toEqual([]);
  });

  it('returns null for an empty generated mock', () => {
    expect(toSyntheticMockContent(null)).toBeNull();
    expect(toSyntheticMockContent({ questions: [] })).toBeNull();
  });

  it('round-trips a cached generated mock through settings', async () => {
    expect(await getCachedGeneratedMock('level1')).toBeNull();
    const saved = await saveCachedGeneratedMock('level1', { level: 'level1', questions: [q('x')] });
    expect(saved.level).toBe('level1');
    expect((await getCachedGeneratedMock('level1')).questions).toHaveLength(1);
  });

  it('generates grounded questions per topic, tagging ids and skipping topics without curriculum', async () => {
    getCfaSourceReadingForTopic.mockImplementation(async (_level, topicId) =>
      topicId === 'empty-topic' ? { chunks: [] } : { chunks: [{ locator: 'p.1', text: 'curriculum text' }] },
    );
    generateQuestionsFromCurriculum.mockResolvedValue([q('Generated?'), q('Another?')]);

    const onProgress = vi.fn();
    const result = await generateMockExam({
      level: 'level1',
      topics: [
        { topic: 'equity', title: 'Equity' },
        { topic: 'empty-topic', title: 'Empty' },
        { topic: 'fixed-income', title: 'Fixed Income' },
      ],
      settings: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'gemma' },
      onProgress,
    });

    // 2 topics had curriculum × 2 questions each = 4; empty-topic skipped
    expect(result.questions).toHaveLength(4);
    expect(result.questions.map((x) => x.id)).toEqual([
      'gen-equity-1',
      'gen-equity-2',
      'gen-fixed-income-1',
      'gen-fixed-income-2',
    ]);
    expect(result.questions.every((x) => x.topic && x.topicTitle)).toBe(true);
    expect(generateQuestionsFromCurriculum).toHaveBeenCalledTimes(2); // not for empty-topic
    expect(onProgress).toHaveBeenCalled();
  });

  it('caps topics to the level blueprint', async () => {
    getCfaSourceReadingForTopic.mockResolvedValue({ chunks: [{ locator: 'p.1', text: 't' }] });
    generateQuestionsFromCurriculum.mockResolvedValue([q('x')]);
    const topics = Array.from({ length: 20 }, (_, i) => ({ topic: `t${i}`, title: `T${i}` }));
    await generateMockExam({ level: 'level3', topics, settings: {} });
    expect(generateQuestionsFromCurriculum).toHaveBeenCalledTimes(MOCK_BLUEPRINTS.level3.maxTopics);
  });

  it('throws a helpful error when nothing could be generated', async () => {
    getCfaSourceReadingForTopic.mockResolvedValue({ chunks: [] });
    await expect(
      generateMockExam({ level: 'level1', topics: [{ topic: 'a', title: 'A' }], settings: {} }),
    ).rejects.toThrow(/No curriculum-grounded questions/);
  });

  it('keeps building when one topic fails but rethrows aborts', async () => {
    getCfaSourceReadingForTopic.mockResolvedValue({ chunks: [{ locator: 'p.1', text: 't' }] });
    generateQuestionsFromCurriculum
      .mockRejectedValueOnce(new Error('model hiccup'))
      .mockResolvedValueOnce([q('ok')]);
    const result = await generateMockExam({
      level: 'level1',
      topics: [
        { topic: 'a', title: 'A' },
        { topic: 'b', title: 'B' },
      ],
      settings: {},
    });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].id).toBe('gen-b-1');
  });

  it('respects an AbortSignal and throws AbortError before calling more topics', async () => {
    getCfaSourceReadingForTopic.mockResolvedValue({ chunks: [{ locator: 'p.1', text: 't' }] });
    generateQuestionsFromCurriculum.mockResolvedValue([q('ok')]);
    const controller = new AbortController();
    // Abort after the first topic is processed by aborting before the second iteration.
    let firstCall = true;
    generateQuestionsFromCurriculum.mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        controller.abort();
      }
      return [q('ok')];
    });
    await expect(
      generateMockExam({
        level: 'level1',
        topics: [
          { topic: 'a', title: 'A' },
          { topic: 'b', title: 'B' },
        ],
        settings: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // Only the first topic's generate call ran.
    expect(generateQuestionsFromCurriculum).toHaveBeenCalledTimes(1);
  });

  it('surfaces a connection failure instead of silently skipping every topic', async () => {
    getCfaSourceReadingForTopic.mockResolvedValue({ chunks: [{ locator: 'p.1', text: 't' }] });
    generateQuestionsFromCurriculum.mockRejectedValue(new Error('Could not reach http://localhost:1234/v1 from the browser. Enable CORS in LM Studio.'));
    await expect(
      generateMockExam({
        level: 'level1',
        topics: [
          { topic: 'a', title: 'A' },
          { topic: 'b', title: 'B' },
        ],
        settings: {},
      }),
    ).rejects.toThrow(/Could not reach/);
  });
});

describe('gateGeneratedQuestion (INT-1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails closed when the gate reports weak distractors', async () => {
    stubGateFetch({
      passed: false,
      reason: 'weak_distractors',
      gate_confidence: 1,
      score: 0.8,
      failure_reasons: ['weak_distractors'],
      gates: [{ gate: 'distractor_quality', passed: false, reason: 'weak_distractors' }],
      checks: {},
      error: null,
    });
    const r = await gateGeneratedQuestion(q('weak one'));
    expect(r.keep).toBe(false);
    expect(r.reachable).toBe(true);
    expect(r.reason).toBe('weak_distractors');
  });

  it('keeps a question the gate passes', async () => {
    stubGateFetch({
      passed: true,
      reason: null,
      gate_confidence: 1,
      score: 1,
      failure_reasons: [],
      gates: [],
      checks: {},
      error: null,
    });
    const r = await gateGeneratedQuestion(q('good one'));
    expect(r.keep).toBe(true);
    expect(r.reachable).toBe(true);
  });

  it('keeps a structurally-mismatched (3-option) question — envelope shape is not a quality fail', async () => {
    stubGateFetch({
      passed: false,
      reason: 'structural',
      gate_confidence: 0,
      score: 0,
      failure_reasons: ['structural'],
      gates: [{ gate: 'structural', passed: false, reason: 'structural' }],
      checks: {},
      error: null,
    });
    const r = await gateGeneratedQuestion(q('cfa shape'));
    expect(r.keep).toBe(true);
    expect(r.reachable).toBe(true);
  });

  it('degrades gracefully (keeps) when the gate could not run (error field set)', async () => {
    stubGateFetch({
      passed: false,
      reason: 'solve_mismatch',
      gate_confidence: 0,
      score: 0,
      failure_reasons: ['solve_mismatch'],
      gates: [],
      checks: {},
      error: 'provider unreachable',
    });
    const r = await gateGeneratedQuestion(q('unverifiable'));
    expect(r.keep).toBe(true);
    expect(r.reachable).toBe(false);
  });

  it('degrades gracefully (keeps) when the sidecar is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const r = await gateGeneratedQuestion(q('offline'));
    expect(r.keep).toBe(true);
    expect(r.reachable).toBe(false);
  });

  it('degrades gracefully (keeps) on a non-2xx gate response', async () => {
    stubGateFetch({}, { status: 503 });
    const r = await gateGeneratedQuestion(q('boom'));
    expect(r.keep).toBe(true);
    expect(r.reachable).toBe(false);
  });

  it('keeps an unmappable shape without calling the gate', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await gateGeneratedQuestion({ question: '', options: [] });
    expect(r.keep).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops weak questions from a generated mock and keeps ids contiguous', async () => {
    getCfaSourceReadingForTopic.mockResolvedValue({ chunks: [{ locator: 'p.1', text: 't' }] });
    generateQuestionsFromCurriculum.mockResolvedValue([q('keep-1'), q('weak'), q('keep-2')]);
    // Gate verdict keyed off the candidate stem so we can reject just "weak".
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        const body = JSON.parse(init.body);
        const isWeak = body.candidate.stem === 'weak';
        return Promise.resolve(
          new Response(
            JSON.stringify({
              passed: !isWeak,
              reason: isWeak ? 'weak_distractors' : null,
              gate_confidence: 1,
              score: isWeak ? 0.7 : 1,
              failure_reasons: isWeak ? ['weak_distractors'] : [],
              gates: [],
              checks: {},
              error: null,
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const result = await generateMockExam({
      level: 'level1',
      topics: [{ topic: 'equity', title: 'Equity' }],
      settings: {},
    });
    expect(result.questions.map((x) => x.question)).toEqual(['keep-1', 'keep-2']);
    expect(result.questions.map((x) => x.id)).toEqual(['gen-equity-1', 'gen-equity-2']);
  });
});
