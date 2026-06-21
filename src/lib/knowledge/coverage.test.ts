import { describe, expect, it, vi } from 'vitest';

import {
  coverageGapsToWeakTopics,
  enqueueCoverageGapJobs,
  mineOutcomesFromChunks,
  reconcileCoverage,
  type AuthoredObjective,
  type MinedOutcome,
} from './coverage';
import type { WeakTopicInput } from '../targetedMaterialQueue';

const authored: AuthoredObjective[] = [
  { id: 'fi-1', topicId: 'fixed-income', title: 'Calculate Macaulay duration and modified duration', level: 'level1' },
  { id: 'fi-2', topicId: 'fixed-income', title: 'Explain convexity and its effect on bond price', level: 'level1' },
  { id: 'eq-1', topicId: 'equity', title: 'Describe the dividend discount model', level: 'level1' },
];

describe('CONTENT-2 — reconcileCoverage', () => {
  it('classifies covered / partial / orphan by match score', () => {
    const mined: MinedOutcome[] = [
      // Strong overlap with fi-1 (duration / modified / macaulay)
      { text: 'Macaulay duration and modified duration measure interest rate risk', topicId: 'fixed-income' },
      // Weak partial overlap with fi-2 (only "convexity")
      { text: 'convexity', topicId: 'fixed-income' },
      // Nothing matches eq-1 → orphan
    ];
    const report = reconcileCoverage(authored, mined);
    const byId = new Map(report.objectives.map((o) => [o.objectiveId, o]));
    expect(byId.get('fi-1')?.status).toBe('covered');
    expect(byId.get('fi-2')?.status).toBe('partial');
    expect(byId.get('eq-1')?.status).toBe('orphan');
    expect(report.covered).toBe(1);
    expect(report.partial).toBe(1);
    expect(report.orphan).toBe(1);
  });

  it('is topic-scoped: an outcome in another topic cannot cover this objective', () => {
    const mined: MinedOutcome[] = [
      // Same words as fi-1 but tagged to a different topic → must NOT cover fi-1.
      { text: 'Calculate Macaulay duration and modified duration', topicId: 'equity' },
    ];
    const report = reconcileCoverage(authored, mined);
    const fi1 = report.objectives.find((o) => o.objectiveId === 'fi-1')!;
    expect(fi1.status).toBe('orphan');
  });

  it('outcomes without a topicId match any objective', () => {
    const mined: MinedOutcome[] = [{ text: 'dividend discount model values equity from dividends' }];
    const report = reconcileCoverage(authored, mined);
    const eq1 = report.objectives.find((o) => o.objectiveId === 'eq-1')!;
    expect(eq1.status).toBe('covered');
  });

  it('coverageRatio counts covered as full and partial as half', () => {
    const report = reconcileCoverage(authored, [
      { text: 'Macaulay duration and modified duration', topicId: 'fixed-income' },
      { text: 'convexity', topicId: 'fixed-income' },
    ]);
    // 1 covered + 1 partial + 1 orphan over 3 → (1 + 0.5) / 3 = 0.5
    expect(report.coverageRatio).toBeCloseTo(0.5, 5);
  });

  it('empty authored set yields a zeroed report', () => {
    const report = reconcileCoverage([], []);
    expect(report.total).toBe(0);
    expect(report.coverageRatio).toBe(0);
  });
});

describe('CONTENT-2 — coverageGapsToWeakTopics', () => {
  it('maps orphan→mastery 0 and partial→0.4, aggregating worst per topic', () => {
    const report = reconcileCoverage(authored, [
      { text: 'convexity', topicId: 'fixed-income' }, // fi-2 partial; fi-1 orphan
    ]);
    const weak = coverageGapsToWeakTopics(report);
    const fi = weak.find((w) => w.topic === 'fixed-income')!;
    // fixed-income has an orphan (fi-1) → worst mastery wins → 0
    expect(fi.mastery).toBe(0);
    const eq = weak.find((w) => w.topic === 'equity')!;
    expect(eq.mastery).toBe(0);
    expect(weak.every((w) => w.domain === 'cfa')).toBe(true);
  });

  it('excludes covered objectives from the gap list', () => {
    const report = reconcileCoverage(authored, [
      { text: 'Macaulay duration and modified duration', topicId: 'fixed-income' }, // fi-1 covered
      { text: 'convexity and bond price effect explained', topicId: 'fixed-income' }, // fi-2 covered
      { text: 'dividend discount model describes equity value', topicId: 'equity' }, // eq-1 covered
    ]);
    expect(coverageGapsToWeakTopics(report)).toEqual([]);
  });
});

describe('CONTENT-2 — enqueueCoverageGapJobs (queue public API bridge)', () => {
  it('forwards derived weak-topics to the injected queue enqueue and returns its jobs', async () => {
    const report = reconcileCoverage(authored, []); // everything orphan
    const enqueue = vi.fn(async ({ weakTopics }: { weakTopics: WeakTopicInput[] }) =>
      weakTopics.map((w) => ({
        id: `targeted:${w.domain}:${w.level}:${w.topic}:summary`,
        domain: w.domain,
        level: w.level,
        topic: w.topic,
        title: w.title,
        kind: 'summary' as const,
        status: 'pending' as const,
        reason: 'gap',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    );
    const result = await enqueueCoverageGapJobs(report, { enqueue });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0][0];
    expect(call.weakTopics.map((w) => w.topic).sort()).toEqual(['equity', 'fixed-income']);
    expect(result.jobs.length).toBe(2);
  });

  it('is a no-op (no enqueue call) when there are no gaps', async () => {
    const report = reconcileCoverage([], []);
    const enqueue = vi.fn();
    const result = await enqueueCoverageGapJobs(report, { enqueue });
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.jobs).toEqual([]);
  });
});

describe('CONTENT-2 — mineOutcomesFromChunks', () => {
  it('keeps command-verb LOS lines and short headings, dropping prose', () => {
    const outcomes = mineOutcomesFromChunks([
      {
        text: 'Calculate the modified duration of a bond.\nThis is a long paragraph of explanatory prose that runs well past ninety characters and ends with a period.\nFixed Income Overview',
        topicId: 'fixed-income',
        locator: 'p. 12',
      },
    ]);
    const texts = outcomes.map((o) => o.text);
    expect(texts).toContain('Calculate the modified duration of a bond.');
    expect(texts).toContain('Fixed Income Overview');
    expect(texts.some((t) => t.startsWith('This is a long paragraph'))).toBe(false);
    expect(outcomes[0].topicId).toBe('fixed-income');
    expect(outcomes[0].locator).toBe('p. 12');
  });

  it('dedupes identical lines within a topic', () => {
    const outcomes = mineOutcomesFromChunks([
      { text: 'Explain convexity.', topicId: 't' },
      { text: 'Explain convexity.', topicId: 't' },
    ]);
    expect(outcomes).toHaveLength(1);
  });
});
