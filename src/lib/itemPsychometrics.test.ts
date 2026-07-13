import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_ATTEMPTS,
  PSYCHOMETRICS_CACHE_KEY,
  TOO_EASY_THRESHOLD,
  TOO_HARD_THRESHOLD,
  clearPsychometricsCache,
  computePsychometrics,
  pearson,
  persistPsychometricsReport,
  readCachedPsychometricsReport,
} from './itemPsychometrics';
import { db } from './progressStore';
import type { Confidence, QuestionResult } from './learningTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

function result(
  questionId: string,
  topic: string,
  daysAgo: number,
  correct: boolean,
  confidence: Confidence = 'medium',
): QuestionResult {
  return {
    domain: 'cfa',
    topic,
    questionId,
    learningObjective: `${topic}::lo`,
    correct,
    confidence,
    errorCategory: 'none',
    difficulty: 'intermediate',
    createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  };
}

beforeEach(async () => {
  await db.settings.clear();
});

afterEach(async () => {
  await clearPsychometricsCache();
});

describe('pearson', () => {
  it('returns 1 for perfectly correlated arrays', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
  });

  it('returns -1 for perfectly anti-correlated arrays', () => {
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
  });

  it('returns 0 for orthogonal arrays', () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });

  it('handles degenerate inputs', () => {
    expect(pearson([], [])).toBe(0);
    expect(pearson([1], [2])).toBe(0);
    expect(pearson([1, 2, 3], [1, 2])).toBe(0); // length mismatch
  });
});

describe('computePsychometrics — flags', () => {
  it(`flags items with fewer than ${MIN_ATTEMPTS} attempts as insufficient-data`, () => {
    const rows: QuestionResult[] = [
      result('q1', 'quant', 5, true),
      result('q1', 'quant', 1, true),
    ];
    const report = computePsychometrics(rows);
    const item = report.items.find((it) => it.questionId === 'q1');
    expect(item?.flag).toBe('insufficient-data');
    expect(report.itemsByFlag['insufficient-data']).toBe(1);
  });

  it('flags always-correct items as too-easy', () => {
    const rows: QuestionResult[] = [];
    for (let i = 0; i < 5; i++) rows.push(result('q1', 'quant', 5 - i, true));
    // Also add a topic baseline so discrimination has signal
    for (let i = 0; i < 5; i++) rows.push(result('q2', 'quant', 5 - i, i % 2 === 0));
    const report = computePsychometrics(rows);
    const easy = report.items.find((it) => it.questionId === 'q1');
    expect(easy?.accuracy).toBeGreaterThanOrEqual(TOO_EASY_THRESHOLD);
    expect(easy?.flag).toBe('too-easy');
  });

  it('flags always-wrong items as too-hard', () => {
    const rows: QuestionResult[] = [];
    for (let i = 0; i < 5; i++) rows.push(result('q1', 'quant', 5 - i, false));
    for (let i = 0; i < 5; i++) rows.push(result('q2', 'quant', 5 - i, i % 2 === 0));
    const report = computePsychometrics(rows);
    const hard = report.items.find((it) => it.questionId === 'q1');
    expect(hard?.accuracy).toBeLessThanOrEqual(TOO_HARD_THRESHOLD);
    expect(hard?.flag).toBe('too-hard');
  });

  it('produces a discrimination value in [-1, 1] and a non-null reliability SE', () => {
    const rows: QuestionResult[] = [];
    // Mixed item performance.
    const pattern = [true, false, true, true, false, true];
    for (let i = 0; i < pattern.length; i++) {
      rows.push(result('q1', 'quant', pattern.length - i, pattern[i]));
      // Baseline so the rolling topic accuracy has signal:
      rows.push(result('q2', 'quant', pattern.length - i, i % 3 === 0));
    }
    const report = computePsychometrics(rows);
    const target = report.items.find((it) => it.questionId === 'q1');
    expect(target).toBeDefined();
    expect(target!.discrimination).toBeGreaterThanOrEqual(-1);
    expect(target!.discrimination).toBeLessThanOrEqual(1);
    expect(target!.reliabilitySE).toBeGreaterThanOrEqual(0);
    expect(target!.reliabilitySE).toBeLessThan(1);
  });
});

describe('computePsychometrics — report shape', () => {
  it('counts items by flag', () => {
    const rows: QuestionResult[] = [
      // too-easy
      result('q1', 'quant', 5, true),
      result('q1', 'quant', 4, true),
      result('q1', 'quant', 3, true),
      // too-hard
      result('q2', 'quant', 5, false),
      result('q2', 'quant', 4, false),
      result('q2', 'quant', 3, false),
      // insufficient-data
      result('q3', 'quant', 5, true),
    ];
    const report = computePsychometrics(rows);
    expect(report.totalAttempts).toBe(rows.length);
    expect(report.itemsByFlag['too-easy']).toBe(1);
    expect(report.itemsByFlag['too-hard']).toBe(1);
    expect(report.itemsByFlag['insufficient-data']).toBe(1);
    expect(report.items.length).toBe(3);
    // too-hard sorts first in the items list.
    expect(report.items[0].flag).toBe('too-hard');
  });

  it('respects topic boundaries when grouping', () => {
    const rows: QuestionResult[] = [
      result('q1', 'quant', 3, true),
      result('q1', 'quant', 2, true),
      result('q1', 'quant', 1, true),
      // SAME questionId, DIFFERENT topic — they're treated as one item per
      // (domain, questionId); this test pins the documented behavior.
      result('q1', 'derivatives', 2, false),
    ];
    const report = computePsychometrics(rows);
    expect(report.items.length).toBe(1);
    expect(report.items[0].attempts).toBe(4);
  });
});

describe('persist / read / clear', () => {
  it('round-trips a report through storage', async () => {
    const report = computePsychometrics([
      result('q1', 'quant', 5, true),
      result('q1', 'quant', 3, true),
      result('q1', 'quant', 1, false),
    ]);
    await persistPsychometricsReport(report);
    const cached = await readCachedPsychometricsReport();
    expect(cached?.totalAttempts).toBe(report.totalAttempts);
    expect(cached?.items.length).toBe(report.items.length);

    await clearPsychometricsCache();
    expect(await readCachedPsychometricsReport()).toBeNull();
  });

  it('exposes the storage key constant', () => {
    expect(PSYCHOMETRICS_CACHE_KEY).toBe('item-psychometrics:cache');
  });
});
