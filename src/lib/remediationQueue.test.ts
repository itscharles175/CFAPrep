import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionAttempt } from './learningTypes';

const mocks = vi.hoisted(() => {
  const settings = new Map<string, { key: string; value: unknown; updatedAt: string }>();
  const targetedJobs: Array<Record<string, unknown>> = [];
  const storedAttempts: QuestionAttempt[] = [];
  return { settings, targetedJobs, storedAttempts, recoverInterrupted: vi.fn(async () => targetedJobs) };
});

vi.mock('./storage', () => ({
  getStorage: () => ({
    questionResults: { toArray: async () => mocks.storedAttempts },
    settings: {
      get: async (key: string) => mocks.settings.get(key),
      put: async (row: { key: string; value: unknown; updatedAt: string }) => void mocks.settings.set(row.key, row),
      delete: async (key: string) => void mocks.settings.delete(key),
    },
  }),
}));

vi.mock('./targetedMaterialQueue', () => ({
  jobIdFor: (domain: string, level: string, topic: string, kind: string) =>
    `targeted:${domain}:${level}:${topic}:${kind}`,
  readQueue: async () => mocks.targetedJobs,
  recoverInterruptedTargetedMaterialJobs: mocks.recoverInterrupted,
  generateTargetedMaterialJobs: vi.fn(async ({ weakTopics, now }) => {
    for (const weak of weakTopics) {
      const id = `targeted:${weak.domain}:${weak.level}:${weak.topic}:questions`;
      if (!mocks.targetedJobs.some((job) => job.id === id)) {
        mocks.targetedJobs.push({
          id,
          ...weak,
          kind: 'questions',
          status: 'pending',
          reason: 'remediation',
          createdAt: (now ?? new Date()).toISOString(),
        });
      }
    }
    return mocks.targetedJobs;
  }),
}));

import {
  completeRemediationEntry,
  enqueueRemediationAttempt,
  enqueueRemediationPracticePackets,
  readRemediationQueue,
  reconcileRemediationAttempts,
  reconcileStoredRemediationAttempts,
  recoverRemediationWork,
  remediationAttemptKey,
} from './remediationQueue';

const NOW = new Date('2026-09-13T12:00:00.000Z');

function attempt(overrides: Partial<QuestionAttempt> = {}): QuestionAttempt {
  return {
    id: 42,
    domain: 'cfa',
    level: 'level1',
    topic: 'fixed-income',
    questionId: 'fi-q1',
    learningObjective: 'fi-los-a',
    title: 'Fixed Income',
    correct: false,
    confidence: 'medium',
    errorCategory: 'concept',
    difficulty: 'intermediate',
    createdAt: '2026-09-13T11:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.settings.clear();
  mocks.targetedJobs.splice(0);
  mocks.storedAttempts.splice(0);
  mocks.recoverInterrupted.mockClear();
});

describe('remediation queue', () => {
  it('queues incorrect and correct low-confidence attempts, but skips confident correct work', async () => {
    expect((await enqueueRemediationAttempt(attempt(), {}, { now: NOW }))?.trigger).toBe('incorrect');
    expect(
      (await enqueueRemediationAttempt(attempt({ id: 43, correct: true, confidence: 'low' }), {}, { now: NOW }))
        ?.trigger,
    ).toBe('low-confidence');
    expect(await enqueueRemediationAttempt(attempt({ id: 44, correct: true, confidence: 'medium' }))).toBeNull();
    expect(await readRemediationQueue()).toHaveLength(2);
  });

  it('deduplicates repeated reconciliation by the durable host attempt identity', async () => {
    await reconcileRemediationAttempts([attempt(), attempt()], { now: NOW });
    const entries = await reconcileRemediationAttempts([attempt()], { now: NOW });
    expect(entries).toHaveLength(1);
    expect(entries[0].attempt.attemptKey).toBe(remediationAttemptKey(attempt()));
  });

  it('can reconcile directly from the active host attempt store at startup', async () => {
    mocks.storedAttempts.push(attempt());
    const entries = await reconcileStoredRemediationAttempts({ now: NOW });
    expect(entries).toHaveLength(1);
    expect(entries[0].attempt.questionId).toBe('fi-q1');
  });

  it('retains explanation and supporting material provenance when supplied', async () => {
    const entry = await enqueueRemediationAttempt(
      attempt(),
      {
        explanation: 'Duration rises when yield falls.',
        supportingMaterial: [{ sourceId: 'curriculum', title: 'Duration', locator: 'p. 12' }],
      },
      { now: NOW },
    );
    expect(entry?.evidenceStatus).toBe('grounded');
    expect(entry?.supportingMaterial[0].locator).toBe('p. 12');
  });

  it('creates one deduplicated practice packet job per topic and links its mistakes', async () => {
    await enqueueRemediationAttempt(attempt(), {}, { now: NOW });
    await enqueueRemediationAttempt(attempt({ id: 43, questionId: 'fi-q2' }), {}, { now: NOW });
    const result = await enqueueRemediationPracticePackets([], { now: NOW });
    expect(result.jobs).toHaveLength(1);
    expect(result.entries).toHaveLength(2);
    expect(new Set(result.entries.map((entry) => entry.targetedJobId)).size).toBe(1);
    expect(result.entries.every((entry) => entry.status === 'packet-pending')).toBe(true);
  });

  it('recovers interrupted packet work and reflects a completed generated packet', async () => {
    await enqueueRemediationAttempt(attempt(), {}, { now: NOW });
    await enqueueRemediationPracticePackets([], { now: NOW });
    mocks.targetedJobs[0].status = 'done';
    const recovered = await recoverRemediationWork({ now: NOW });
    expect(mocks.recoverInterrupted).toHaveBeenCalledOnce();
    expect(recovered[0].status).toBe('packet-ready');
  });

  it('marks remediation complete without deleting its attempt evidence', async () => {
    const entry = await enqueueRemediationAttempt(attempt(), {}, { now: NOW });
    const updated = await completeRemediationEntry(entry!.id, { now: NOW });
    expect(updated[0].status).toBe('completed');
    expect(updated[0].attempt.questionId).toBe('fi-q1');
  });
});
