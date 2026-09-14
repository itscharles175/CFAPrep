import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Hoisted mock state (vi.mock factories run before module imports, so anything
// they close over must live in a hoisted block).
// --------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const settingsStore = new Map<string, { key: string; value: unknown; updatedAt: string }>();
  return {
    settingsStore,
    generateQuestionsFromCurriculum: vi.fn(async () => [{ id: 'q1', question: 'Q?', options: ['a', 'b'], correct: 0 }]),
    generateFlashcardsFromCurriculum: vi.fn(async () => [{ id: 'f1', front: 'F', back: 'B' }]),
    summarizeTopicFromCurriculum: vi.fn(async () => 'A summary paragraph.'),
    saveCachedGeneratedQuestions: vi.fn(async () => undefined),
    saveCachedGeneratedFlashcards: vi.fn(async () => undefined),
    saveCachedTopicSummary: vi.fn(async () => undefined),
    getCachedGeneratedQuestions: vi.fn(async () => null as unknown),
    getCachedGeneratedFlashcards: vi.fn(async () => null as unknown),
    getCachedTopicSummary: vi.fn(async () => null as unknown),
    getLlmSettings: vi.fn(async () => ({ enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'gemma' })),
  };
});

const { settingsStore } = mocks;

vi.mock('./storage', () => ({
  getStorage: () => ({
    settings: {
      get: async (key: string) => settingsStore.get(key),
      put: async (row: { key: string; value: unknown; updatedAt: string }) => {
        settingsStore.set(row.key, row);
      },
      delete: async (key: string) => {
        settingsStore.delete(key);
      },
      toArray: async () => Array.from(settingsStore.values()),
      bulkDelete: async () => undefined,
      clear: async () => {
        settingsStore.clear();
      },
    },
  }),
}));

vi.mock('./localLlm', () => ({
  generateQuestionsFromCurriculum: mocks.generateQuestionsFromCurriculum,
  generateFlashcardsFromCurriculum: mocks.generateFlashcardsFromCurriculum,
  summarizeTopicFromCurriculum: mocks.summarizeTopicFromCurriculum,
  saveCachedGeneratedQuestions: mocks.saveCachedGeneratedQuestions,
  saveCachedGeneratedFlashcards: mocks.saveCachedGeneratedFlashcards,
  saveCachedTopicSummary: mocks.saveCachedTopicSummary,
  getCachedGeneratedQuestions: mocks.getCachedGeneratedQuestions,
  getCachedGeneratedFlashcards: mocks.getCachedGeneratedFlashcards,
  getCachedTopicSummary: mocks.getCachedTopicSummary,
  getLlmSettings: mocks.getLlmSettings,
}));

vi.mock('./cfaSourceVault', () => ({
  getCfaSourceReadingForTopic: vi.fn(async () => ({
    document: { id: 'doc-1', title: 'CFA Curriculum' },
    chunks: [
      { locator: 'p1', text: 'Some curriculum text here.' },
      { locator: 'p2', text: 'More curriculum text.' },
    ],
  })),
}));

const {
  generateQuestionsFromCurriculum,
  generateFlashcardsFromCurriculum,
  summarizeTopicFromCurriculum,
  saveCachedGeneratedQuestions,
  saveCachedGeneratedFlashcards,
  saveCachedTopicSummary,
  getCachedGeneratedQuestions,
  getCachedGeneratedFlashcards,
  getCachedTopicSummary,
  getLlmSettings,
} = mocks;

// --------------------------------------------------------------------------

import {
  DEFAULT_PER_TOPIC_LIMIT,
  DEFAULT_THRESHOLD,
  TARGETED_QUEUE_KEY,
  clearQueue,
  generateTargetedMaterialJobs,
  jobIdFor,
  readQueue,
  recoverInterruptedTargetedMaterialJobs,
  runTargetedMaterialJob,
  type TargetedMaterialJob,
} from './targetedMaterialQueue';

const FIXED_NOW = new Date('2026-05-27T10:00:00.000Z');

beforeEach(async () => {
  settingsStore.clear();
  generateQuestionsFromCurriculum.mockClear();
  generateFlashcardsFromCurriculum.mockClear();
  summarizeTopicFromCurriculum.mockClear();
  saveCachedGeneratedQuestions.mockClear();
  saveCachedGeneratedFlashcards.mockClear();
  saveCachedTopicSummary.mockClear();
  getCachedGeneratedQuestions.mockResolvedValue(null);
  getCachedGeneratedFlashcards.mockResolvedValue(null);
  getCachedTopicSummary.mockResolvedValue(null);
  getLlmSettings.mockResolvedValue({ enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'gemma' });
});

describe('generateTargetedMaterialJobs', () => {
  it('does not create jobs for topics above the threshold', async () => {
    const jobs = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'equity', title: 'Equity', mastery: 0.85 },
      ],
      now: FIXED_NOW,
    });
    expect(jobs).toHaveLength(0);
  });

  it('creates `perTopicLimit` jobs per topic below threshold', async () => {
    const jobs = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    expect(jobs).toHaveLength(DEFAULT_PER_TOPIC_LIMIT);
    // Default kind order produces "questions" then "flashcards".
    expect(jobs.map((j) => j.kind)).toEqual(['questions', 'flashcards']);
    for (const job of jobs) {
      expect(job.status).toBe('pending');
      expect(job.reason).toContain('Fixed Income');
    }
  });

  it('respects a higher perTopicLimit by emitting all three kinds', async () => {
    const jobs = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fsa', title: 'Financial Stmt Analysis', mastery: 0.20 },
      ],
      perTopicLimit: 3,
      now: FIXED_NOW,
    });
    expect(jobs.map((j) => j.kind)).toEqual(['questions', 'flashcards', 'summary']);
  });

  it('suppresses a new job when a fresh artifact already exists for that kind', async () => {
    // Pretend a fresh "questions" artifact exists in the cache.
    getCachedGeneratedQuestions.mockResolvedValueOnce({
      questions: [],
      generatedAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString(),
    });
    const jobs = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    // "questions" should be suppressed; only "flashcards" + ... fills the quota.
    const kinds = jobs.map((j) => j.kind);
    expect(kinds).not.toContain('questions');
    expect(kinds).toContain('flashcards');
    expect(jobs).toHaveLength(DEFAULT_PER_TOPIC_LIMIT);
  });

  it('does NOT suppress a job when the cached artifact is older than 7 days', async () => {
    const stale = new Date(FIXED_NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    getCachedGeneratedQuestions.mockResolvedValueOnce({
      questions: [],
      generatedAt: stale,
    });
    const jobs = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    expect(jobs.map((j) => j.kind)).toContain('questions');
  });

  it('persists the queue under the configured storage key, readable across calls', async () => {
    await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    // Storage contains the queue.
    expect(settingsStore.has(TARGETED_QUEUE_KEY)).toBe(true);
    // Second call returns the SAME jobs (idempotent for the same inputs + cache).
    const second = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    expect(second).toHaveLength(DEFAULT_PER_TOPIC_LIMIT);
    // readQueue surfaces the persisted entries directly.
    const persisted = await readQueue();
    expect(persisted).toHaveLength(DEFAULT_PER_TOPIC_LIMIT);
    expect(persisted[0].id).toBe(jobIdFor('cfa', 'level1', 'fixed-income', 'questions'));
  });

  it('uses the supplied threshold to filter weak topics', async () => {
    const jobs = await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.40 },
      ],
      threshold: 0.30,
      now: FIXED_NOW,
    });
    // 0.40 >= 0.30 → no jobs
    expect(jobs).toHaveLength(0);
    expect(DEFAULT_THRESHOLD).toBe(0.55);
  });

  it('clearQueue removes the persisted entry', async () => {
    await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    expect(settingsStore.has(TARGETED_QUEUE_KEY)).toBe(true);
    await clearQueue();
    expect(settingsStore.has(TARGETED_QUEUE_KEY)).toBe(false);
  });
});

describe('runTargetedMaterialJob', () => {
  function pendingJob(kind: 'questions' | 'flashcards' | 'summary'): TargetedMaterialJob {
    return {
      id: jobIdFor('cfa', 'level1', 'fixed-income', kind),
      domain: 'cfa',
      level: 'level1',
      topic: 'fixed-income',
      title: 'Fixed Income',
      kind,
      status: 'pending',
      reason: 'mastery 30%',
      createdAt: FIXED_NOW.toISOString(),
    };
  }

  it('routes "questions" to generateQuestionsFromCurriculum and saves the cache', async () => {
    const result = await runTargetedMaterialJob(pendingJob('questions'));
    expect(generateQuestionsFromCurriculum).toHaveBeenCalledTimes(1);
    expect(saveCachedGeneratedQuestions).toHaveBeenCalledWith('level1', 'fixed-income', expect.any(Array));
    expect(result.status).toBe('done');
    expect(result.completedAt).toBeDefined();
  });

  it('routes "flashcards" to generateFlashcardsFromCurriculum and saves the cache', async () => {
    const result = await runTargetedMaterialJob(pendingJob('flashcards'));
    expect(generateFlashcardsFromCurriculum).toHaveBeenCalledTimes(1);
    expect(saveCachedGeneratedFlashcards).toHaveBeenCalledWith('level1', 'fixed-income', expect.any(Array));
    expect(result.status).toBe('done');
  });

  it('routes "summary" to summarizeTopicFromCurriculum and saves the cache', async () => {
    const result = await runTargetedMaterialJob(pendingJob('summary'));
    expect(summarizeTopicFromCurriculum).toHaveBeenCalledTimes(1);
    expect(saveCachedTopicSummary).toHaveBeenCalledWith('level1', 'fixed-income', expect.any(String));
    expect(result.status).toBe('done');
  });

  it('marks the job as error when the local model is disabled', async () => {
    getLlmSettings.mockResolvedValueOnce({ enabled: false, baseUrl: '', model: '' });
    const result = await runTargetedMaterialJob(pendingJob('questions'));
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/local model/i);
  });

  it('updates the persisted queue entry to match the new status', async () => {
    // Seed a pending entry into the queue so readQueue() finds it.
    await generateTargetedMaterialJobs({
      weakTopics: [
        { domain: 'cfa', level: 'level1', topic: 'fixed-income', title: 'Fixed Income', mastery: 0.30 },
      ],
      now: FIXED_NOW,
    });
    const before = await readQueue();
    const target = before.find((j) => j.kind === 'questions')!;
    await runTargetedMaterialJob(target);
    const after = await readQueue();
    const persisted = after.find((j) => j.id === target.id)!;
    expect(persisted.status).toBe('done');
  });

  it('returns an aborted job to pending so it can be resumed', async () => {
    const controller = new AbortController();
    generateQuestionsFromCurriculum.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const result = await runTargetedMaterialJob(pendingJob('questions'), { signal: controller.signal });
    expect(result.status).toBe('pending');
    expect(result.error).toBeUndefined();
  });

  it('recovers jobs stranded in running after an app interruption', async () => {
    const job = { ...pendingJob('questions'), status: 'running' as const };
    settingsStore.set(TARGETED_QUEUE_KEY, {
      key: TARGETED_QUEUE_KEY,
      value: [job],
      updatedAt: FIXED_NOW.toISOString(),
    });
    const recovered = await recoverInterruptedTargetedMaterialJobs();
    expect(recovered[0].status).toBe('pending');
  });
});
