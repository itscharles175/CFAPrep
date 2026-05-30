import { beforeEach, describe, expect, it } from 'vitest';
import { migrateData, type MigrationReport } from './migrate';
import type {
  MasterySnapshotStore,
  QuestionResultStore,
  ReviewItemStore,
  StorageDriver,
  StorageSettingRow,
} from './types';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';

// ---------------------------------------------------------------------------
// In-memory fake drivers — exercise migrateData() without IndexedDB/SurrealDB.
// ---------------------------------------------------------------------------

function makeSettings(seed: StorageSettingRow[] = []) {
  const map = new Map<string, StorageSettingRow>(seed.map((r) => [r.key, r]));
  return {
    map,
    store: {
      async get(key: string) {
        return map.get(key);
      },
      async put(row: StorageSettingRow) {
        map.set(row.key, row);
      },
      async delete(key: string) {
        map.delete(key);
      },
      async toArray() {
        return [...map.values()];
      },
      async bulkDelete(keys: string[]) {
        keys.forEach((k) => map.delete(k));
      },
      async clear() {
        map.clear();
      },
    },
  };
}

function makeReviewItems(seed: ReviewItem[] = []) {
  const map = new Map<string, ReviewItem>(seed.map((r) => [r.id, r]));
  const store: ReviewItemStore = {
    async get(id) {
      return map.get(id);
    },
    async put(item) {
      map.set(item.id, item);
    },
    async bulkPut(items) {
      items.forEach((i) => map.set(i.id, i));
    },
    async toArray() {
      return [...map.values()];
    },
    async delete(id) {
      map.delete(id);
    },
  };
  return { map, store };
}

function makeQuestionResults(seed: QuestionResult[] = []) {
  const rows: QuestionResult[] = [...seed];
  const store: QuestionResultStore = {
    async add(result) {
      rows.push(result);
    },
    async bulkAdd(results) {
      rows.push(...results);
    },
    async toArray() {
      return [...rows];
    },
    async byTopic(domain, topic) {
      return rows.filter((r) => r.domain === domain && r.topic === topic);
    },
    async clear() {
      rows.length = 0;
    },
  };
  return { rows, store };
}

function makeMastery(seed: MasterySnapshot[] = []) {
  const map = new Map<string, MasterySnapshot>(seed.map((s) => [s.id, s]));
  const store: MasterySnapshotStore = {
    async get(id) {
      return map.get(id);
    },
    async put(snap) {
      map.set(snap.id, snap);
    },
    async toArray() {
      return [...map.values()];
    },
  };
  return { map, store };
}

function review(id: string): ReviewItem {
  return {
    id,
    domain: 'cfa',
    topic: 'quant',
    learningObjective: 'lo',
    title: id,
    path: `/cfa/${id}`,
    intervalDays: 3,
    ease: 2.5,
    fsrsDifficulty: 5,
    dueAt: '2026-06-01T09:00:00.000Z',
    attempts: 1,
    correctStreak: 1,
  } as ReviewItem;
}

function qResult(qid: string): QuestionResult {
  return {
    domain: 'cfa',
    topic: 'quant',
    questionId: qid,
    learningObjective: 'lo',
    correct: true,
    confidence: 'medium',
    errorCategory: 'none',
    difficulty: 'intermediate',
    createdAt: '2026-05-01T00:00:00.000Z',
  } as QuestionResult;
}

function mastery(id: string): MasterySnapshot {
  return {
    id,
    domain: 'cfa',
    topic: 'quant',
    learningObjective: 'lo',
    title: id,
    score: 70,
    attempts: 3,
    correct: 2,
    confidenceScore: 0.6,
    lastAttemptAt: '2026-05-01T00:00:00.000Z',
    trend: 'up',
  };
}

describe('migrateData', () => {
  let source: StorageDriver;
  let target: StorageDriver;
  let sourceParts: ReturnType<typeof buildParts>;
  let targetParts: ReturnType<typeof buildParts>;

  function buildParts(seed: boolean) {
    const settings = makeSettings(
      seed ? [{ key: 'a', value: 1, updatedAt: 't' }, { key: 'b', value: 2, updatedAt: 't' }] : [],
    );
    const reviewItems = makeReviewItems(seed ? [review('r1'), review('r2')] : []);
    const questionResults = makeQuestionResults(seed ? [qResult('q1'), qResult('q2'), qResult('q3')] : []);
    const masterySnapshots = makeMastery(seed ? [mastery('m1')] : []);
    return { settings, reviewItems, questionResults, masterySnapshots };
  }

  function assemble(parts: ReturnType<typeof buildParts>, name: 'dexie' | 'surrealdb'): StorageDriver {
    return {
      name,
      async ready() {
        return true;
      },
      settings: parts.settings.store,
      reviewItems: parts.reviewItems.store,
      questionResults: parts.questionResults.store,
      masterySnapshots: parts.masterySnapshots.store,
    };
  }

  beforeEach(() => {
    sourceParts = buildParts(true);
    targetParts = buildParts(false);
    source = assemble(sourceParts, 'dexie');
    target = assemble(targetParts, 'surrealdb');
  });

  it('copies every readable namespace from source into target', async () => {
    const report: MigrationReport = await migrateData(source, target);

    expect(report.settings).toBe(2);
    expect(report.reviewItems).toBe(2);
    expect(report.questionResults).toBe(3);
    expect(report.masterySnapshots).toBe(1);

    expect(await target.settings.toArray()).toHaveLength(2);
    expect(await target.reviewItems!.toArray()).toHaveLength(2);
    expect(await target.questionResults!.toArray()).toHaveLength(3);
    expect(await target.masterySnapshots!.toArray()).toHaveLength(1);
  });

  it('always reports chunks as skipped (no generic read-all)', async () => {
    const report = await migrateData(source, target);
    expect(report.skipped.some((s) => s.startsWith('chunks'))).toBe(true);
  });

  it('skips a namespace the target does not implement', async () => {
    const limitedTarget: StorageDriver = {
      name: 'surrealdb',
      async ready() {
        return true;
      },
      settings: targetParts.settings.store,
      // no reviewItems / questionResults / masterySnapshots
    };
    const report = await migrateData(source, limitedTarget);
    expect(report.settings).toBe(2);
    expect(report.reviewItems).toBe(0);
    expect(report.skipped).toContain('reviewItems');
    expect(report.skipped).toContain('questionResults');
    expect(report.skipped).toContain('masterySnapshots');
  });

  it('is idempotent for keyed namespaces (settings/reviewItems/mastery)', async () => {
    await migrateData(source, target);
    await migrateData(source, target);
    // Keyed upserts — no duplication.
    expect(await target.settings.toArray()).toHaveLength(2);
    expect(await target.reviewItems!.toArray()).toHaveLength(2);
    expect(await target.masterySnapshots!.toArray()).toHaveLength(1);
  });
});
