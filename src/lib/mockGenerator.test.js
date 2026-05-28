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
  generateMockExam,
  getCachedGeneratedMock,
  saveCachedGeneratedMock,
  toSyntheticMockContent,
} from './mockGenerator';
import { db } from './progressStore';

function q(text, correct = 0) {
  return { question: text, options: ['A', 'B', 'C'], correct, explanation: 'because' };
}

describe('mockGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await db.settings.clear();
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
