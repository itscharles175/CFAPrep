import { describe, expect, it } from 'vitest';
import {
  CROSS_DOMAIN_SCHEMA_VERSION,
  createCrossDomainBridge,
  evaluateDataPlaneAlignment,
  fromMasteryFraction,
  hostDifficultyToLsat,
  lsatAttemptToCanonical,
  lsatDifficultyToHost,
  lsatSrsCardToCanonical,
  makeCrossDomainId,
  masterySnapshotToCanonical,
  parseCrossDomainId,
  questionResultToCanonical,
  reviewItemToCanonical,
  toMasteryFraction,
} from './dataDictionary';
import type { MasterySnapshot, QuestionResult, ReviewItem } from './learningTypes';

describe('cross-domain identity (§1)', () => {
  it('builds and round-trips a namespaced id', () => {
    const id = makeCrossDomainId('lsat', 'review', 4821);
    expect(id).toBe('lsat:review:4821');
    expect(parseCrossDomainId(id)).toEqual({ plane: 'lsat', kind: 'review', nativeId: '4821' });
  });

  it('stringifies LSAT integer ids (never reinterprets as number)', () => {
    const parsed = parseCrossDomainId(makeCrossDomainId('lsat', 'attempt', 99012));
    expect(parsed?.nativeId).toBe('99012');
    expect(typeof parsed?.nativeId).toBe('string');
  });

  it('rejects malformed ids', () => {
    expect(parseCrossDomainId('nope')).toBeNull();
    expect(parseCrossDomainId('lsat:review:')).toBeNull();
    expect(parseCrossDomainId('mars:review:1')).toBeNull();
    expect(parseCrossDomainId('lsat:bogus:1')).toBeNull();
  });

  it('preserves a host id containing colons in the native part', () => {
    const parsed = parseCrossDomainId('cfa:review:loi:abc:123');
    expect(parsed).toEqual({ plane: 'cfa', kind: 'review', nativeId: 'loi:abc:123' });
  });
});

describe('difficulty coercion (§2)', () => {
  it('maps LSAT int 1-5 into the host 3-bucket enum', () => {
    expect(lsatDifficultyToHost(1)).toBe('foundation');
    expect(lsatDifficultyToHost(2)).toBe('foundation');
    expect(lsatDifficultyToHost(3)).toBe('intermediate');
    expect(lsatDifficultyToHost(4)).toBe('advanced');
    expect(lsatDifficultyToHost(5)).toBe('advanced');
  });

  it('clamps out-of-range and defaults non-numeric to intermediate', () => {
    expect(lsatDifficultyToHost(0)).toBe('foundation');
    expect(lsatDifficultyToHost(99)).toBe('advanced');
    expect(lsatDifficultyToHost(null)).toBe('intermediate');
    expect(lsatDifficultyToHost(undefined)).toBe('intermediate');
    expect(lsatDifficultyToHost(NaN)).toBe('intermediate');
  });

  it('maps host enum back to the LSAT bucket midpoint (lossy by design)', () => {
    expect(hostDifficultyToLsat('foundation')).toBe(2);
    expect(hostDifficultyToLsat('intermediate')).toBe(3);
    expect(hostDifficultyToLsat('advanced')).toBe(4);
  });

  it('round-trips through the midpoint with at most one step of drift', () => {
    // lsat 1 -> foundation -> lsat 2 (documented extreme drift)
    expect(hostDifficultyToLsat(lsatDifficultyToHost(1))).toBe(2);
    expect(hostDifficultyToLsat(lsatDifficultyToHost(3))).toBe(3);
    expect(hostDifficultyToLsat(lsatDifficultyToHost(5))).toBe(4);
  });
});

describe('mastery scale coercion (§3)', () => {
  it('normalizes host percent and LSAT fraction to a 0..1 fraction', () => {
    expect(toMasteryFraction(72, 'percent')).toBe(0.72);
    expect(toMasteryFraction(0.72, 'fraction')).toBe(0.72);
  });

  it('clamps and defaults', () => {
    expect(toMasteryFraction(150, 'percent')).toBe(1);
    expect(toMasteryFraction(-5, 'percent')).toBe(0);
    expect(toMasteryFraction(null, 'fraction')).toBe(0);
  });

  it('converts a fraction back to either scale', () => {
    expect(fromMasteryFraction(0.72, 'percent')).toBe(72);
    expect(fromMasteryFraction(0.72, 'fraction')).toBe(0.72);
  });
});

describe('canonical mappers (§1-§4)', () => {
  const reviewItem: ReviewItem = {
    id: 'r1',
    domain: 'cfa',
    topic: 'Ethics',
    learningObjective: 'loi-1',
    title: 'Code of Ethics',
    path: '/cfa/x',
    intervalDays: 3,
    ease: 2.5,
    dueAt: '2026-06-20T00:00:00.000Z',
    lastResultAt: '2026-06-15T00:00:00.000Z',
    attempts: 4,
    correctStreak: 2,
    lastCorrect: true,
    lastConfidence: 'medium',
    lastErrorCategory: 'none',
  };

  it('maps a host ReviewItem to canonical', () => {
    const c = reviewItemToCanonical(reviewItem);
    expect(c.crossId).toBe('cfa:review:r1');
    expect(c.questionCrossId).toBe('cfa:question:loi-1');
    expect(c.domain).toBe('cfa');
    expect(c.difficulty).toBe('intermediate');
    expect(c.dueAt).toBe('2026-06-20T00:00:00.000Z');
    expect(c.itemType).toBe('Ethics');
  });

  it('maps a host QuestionResult to canonical', () => {
    const result: QuestionResult = {
      domain: 'quant',
      topic: 'Probability',
      questionId: 'q-42',
      learningObjective: 'loi-2',
      correct: true,
      confidence: 'high',
      errorCategory: 'none',
      difficulty: 'advanced',
      elapsedSeconds: 30,
      createdAt: '2026-06-15T00:00:00.000Z',
    };
    const c = questionResultToCanonical(result, 7);
    expect(c.crossId).toBe('quant:attempt:7');
    expect(c.questionCrossId).toBe('quant:question:q-42');
    expect(c.correct).toBe(true);
    expect(c.confidence).toBe('high');
    expect(c.elapsedSeconds).toBe(30);
  });

  it('maps a host MasterySnapshot (percent) to a 0..1 fraction', () => {
    const snap: MasterySnapshot = {
      id: 'm1',
      domain: 'excel',
      topic: 'Lookups',
      learningObjective: 'loi-3',
      title: 'XLOOKUP',
      score: 84,
      attempts: 10,
      correct: 8,
      confidenceScore: 0.7,
      lastAttemptAt: '2026-06-15T00:00:00.000Z',
      trend: 'up',
    };
    const c = masterySnapshotToCanonical(snap);
    expect(c.crossId).toBe('excel:question:m1');
    expect(c.masteryFraction).toBe(0.84);
    expect(c.key).toBe('loi-3');
  });

  it('maps a raw LSAT SRS card to canonical (difficulty bucketed, identity namespaced)', () => {
    const c = lsatSrsCardToCanonical({
      card_id: 4821,
      question_id: 10,
      stem: 'Which one of the following...',
      q_type: 'Weaken',
      difficulty: 5,
      origin: 'concept_gap_cloze',
      due_date: '2026-06-18T00:00:00.000Z',
    });
    expect(c.crossId).toBe('lsat:review:4821');
    expect(c.questionCrossId).toBe('lsat:question:10');
    expect(c.difficulty).toBe('advanced');
    expect(c.itemType).toBe('Weaken');
    expect(c.origin).toBe('concept_gap_cloze');
    expect(c.title).toContain('Which one');
  });

  it('maps a raw LSAT attempt to canonical (time_ms -> elapsedSeconds)', () => {
    const c = lsatAttemptToCanonical({
      id: 99012,
      question_id: 10,
      is_correct: true,
      chosen_answer: 'C',
      confidence: 'low',
      time_ms: 42000,
      created_at: '2026-06-15T00:00:00.000Z',
    });
    expect(c.crossId).toBe('lsat:attempt:99012');
    expect(c.correct).toBe(true);
    expect(c.chosenAnswer).toBe('C');
    expect(c.elapsedSeconds).toBe(42);
  });
});

describe('cross-domain bridge factory (DATA-2)', () => {
  it('projects native stores onto canonical shapes', async () => {
    const bridge = createCrossDomainBridge({
      reviewItems: {
        async toArray() {
          return [
            {
              id: 'r1',
              domain: 'cfa',
              topic: 'Ethics',
              learningObjective: 'loi-1',
              title: 'X',
              path: '/x',
              intervalDays: 1,
              ease: 2.5,
              dueAt: '2026-06-20T00:00:00.000Z',
              lastResultAt: '2026-06-15T00:00:00.000Z',
              attempts: 1,
              correctStreak: 0,
              lastCorrect: false,
              lastConfidence: 'low',
              lastErrorCategory: 'none',
            } as ReviewItem,
          ];
        },
      },
      questionResults: {
        async toArray() {
          return [
            {
              id: 5,
              domain: 'quant',
              topic: 'P',
              questionId: 'q-1',
              learningObjective: 'loi',
              correct: true,
              confidence: 'high',
              errorCategory: 'none',
              difficulty: 'foundation',
            } as QuestionResult & { id: number },
          ];
        },
      },
      masterySnapshots: {
        async toArray() {
          return [];
        },
      },
    });
    const cards = await bridge.reviewCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].crossId).toBe('cfa:review:r1');
    const attempts = await bridge.attempts();
    expect(attempts[0].crossId).toBe('quant:attempt:5'); // uses the row's own id
    expect(await bridge.mastery()).toEqual([]);
  });

  it('falls back to the array index when a question-result row has no id', async () => {
    const bridge = createCrossDomainBridge({
      questionResults: {
        async toArray() {
          return [
            {
              domain: 'cfa',
              topic: 'T',
              questionId: 'q',
              learningObjective: 'l',
              correct: false,
              confidence: 'low',
              errorCategory: 'none',
              difficulty: 'intermediate',
            } as QuestionResult,
          ];
        },
      },
    });
    const attempts = await bridge.attempts();
    expect(attempts[0].crossId).toBe('cfa:attempt:0');
  });

  it('tolerates missing stores', async () => {
    const bridge = createCrossDomainBridge({});
    expect(await bridge.reviewCards()).toEqual([]);
    expect(await bridge.attempts()).toEqual([]);
    expect(await bridge.mastery()).toEqual([]);
  });
});

describe('schema-version handshake (DATA-3, §5)', () => {
  it('aligns when versions match', () => {
    const a = evaluateDataPlaneAlignment({
      cross_domain_schema_version: CROSS_DOMAIN_SCHEMA_VERSION,
      host_min_supported: 1,
    });
    expect(a.status).toBe('aligned');
    expect(a.crossDomainWritesEnabled).toBe(true);
    expect(a.backendVersion).toBe(CROSS_DOMAIN_SCHEMA_VERSION);
  });

  it('aligns when a newer backend still supports this host', () => {
    const a = evaluateDataPlaneAlignment(
      { cross_domain_schema_version: 3, host_min_supported: 1 },
      2,
    );
    expect(a.status).toBe('aligned');
    expect(a.crossDomainWritesEnabled).toBe(true);
  });

  it('reports a mismatch and disables cross-domain writes', () => {
    const a = evaluateDataPlaneAlignment(
      { cross_domain_schema_version: 5, host_min_supported: 4 },
      2,
    );
    expect(a.status).toBe('mismatch');
    expect(a.crossDomainWritesEnabled).toBe(false);
    expect(a.detail).toMatch(/mismatch/i);
  });

  it('is unreachable (writes disabled) when the backend reports nothing', () => {
    const a = evaluateDataPlaneAlignment(null);
    expect(a.status).toBe('unreachable');
    expect(a.crossDomainWritesEnabled).toBe(false);
    expect(a.backendVersion).toBeNull();
  });
});
