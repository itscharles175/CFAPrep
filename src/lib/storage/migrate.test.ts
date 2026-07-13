import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCutoverManifest,
  guardChunkEmbeddings,
  migrateData,
  type MigrationReport,
} from './migrate';
import type {
  ChunkStore,
  MasterySnapshotStore,
  QuestionResultStore,
  ReviewItemStore,
  SourceChunkInput,
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

// ---------------------------------------------------------------------------
// DATA-7 chunk migration + dimension guard, DATA-2 manifest + overwrite.
// ---------------------------------------------------------------------------

function makeChunks(seed: SourceChunkInput[] = []) {
  const map = new Map<string, SourceChunkInput>(seed.map((c) => [c.id, c]));
  const store: ChunkStore = {
    async upsert(c) {
      map.set(c.id, c);
    },
    async bulkUpsert(cs) {
      cs.forEach((c) => map.set(c.id, { ...c }));
    },
    async deleteByDocument(docId) {
      for (const [k, v] of map) if (v.documentId === docId) map.delete(k);
    },
    async search() {
      return [];
    },
    async exportAll() {
      return [...map.values()].map((c) => ({ ...c }));
    },
  };
  return { map, store };
}

function chunk(id: string, embedding?: number[]): SourceChunkInput {
  return {
    id,
    documentId: 'doc1',
    domain: 'cfa',
    text: `text-${id}`,
    locator: id,
    ...(embedding ? { embedding } : {}),
  };
}

describe('guardChunkEmbeddings (DATA-7)', () => {
  it('returns dimension null and copies text when no chunk carries an embedding', () => {
    const result = guardChunkEmbeddings([chunk('a'), chunk('b')]);
    expect(result.dimension).toBeNull();
    expect(result.embedded).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].embedding).toBeUndefined();
  });

  it('keeps every embedding when the corpus is uniform', () => {
    const result = guardChunkEmbeddings([chunk('a', [1, 2, 3]), chunk('b', [4, 5, 6])]);
    expect(result.dimension).toBe(3);
    expect(result.embedded).toBe(2);
    expect(result.dropped).toBe(0);
    expect(result.chunks.every((c) => Array.isArray(c.embedding))).toBe(true);
  });

  it('drops mismatched embeddings (keeps text) using the modal dimension', () => {
    const result = guardChunkEmbeddings([
      chunk('a', [1, 2, 3]),
      chunk('b', [4, 5, 6]),
      chunk('c', [7, 8]), // odd one out — 2-dim
    ]);
    expect(result.dimension).toBe(3); // modal length
    expect(result.embedded).toBe(2);
    expect(result.dropped).toBe(1);
    const dropped = result.chunks.find((c) => c.id === 'c');
    expect(dropped?.embedding).toBeUndefined();
    expect(dropped?.text).toBe('text-c'); // text preserved
  });

  it('honours an explicit expectedDimension over the modal length', () => {
    const result = guardChunkEmbeddings(
      [chunk('a', [1, 2, 3]), chunk('b', [1, 2]), chunk('c', [3, 4])],
      3, // force 3 even though 2-dim is modal
    );
    expect(result.dimension).toBe(3);
    expect(result.embedded).toBe(1);
    expect(result.dropped).toBe(2);
  });

  it('does not mutate the input rows', () => {
    const input = [chunk('a', [1, 2])];
    guardChunkEmbeddings(input, 3); // would drop the embedding
    expect(input[0].embedding).toEqual([1, 2]); // original untouched
  });

  it('breaks a modal tie toward the LARGER embedding length', () => {
    // counts {2:1, 3:1} — a perfect tie. The tie-break rule
    // `count === bestCount && len > bestLen` selects the larger length (3),
    // so the 3-dim chunk keeps its embedding and the 2-dim one is dropped.
    const result = guardChunkEmbeddings([chunk('a', [1, 2]), chunk('b', [3, 4, 5])]);
    expect(result.dimension).toBe(3);
    expect(result.embedded).toBe(1);
    expect(result.dropped).toBe(1);
    const a = result.chunks.find((c) => c.id === 'a');
    const b = result.chunks.find((c) => c.id === 'b');
    expect(a?.embedding).toBeUndefined(); // 2-dim loses the tie, embedding stripped
    expect(b?.embedding).toEqual([3, 4, 5]); // 3-dim wins the tie, embedding kept
  });

  it('resolves the modal tie identically regardless of input order', () => {
    // Reversed inputs vs. the prior case — same {2:1, 3:1} tie. The tie-break is
    // order-independent: the larger length (3) wins either way.
    const result = guardChunkEmbeddings([chunk('b', [3, 4, 5]), chunk('a', [1, 2])]);
    expect(result.dimension).toBe(3);
    expect(result.embedded).toBe(1);
    expect(result.dropped).toBe(1);
    const a = result.chunks.find((c) => c.id === 'a');
    const b = result.chunks.find((c) => c.id === 'b');
    expect(a?.embedding).toBeUndefined();
    expect(b?.embedding).toEqual([3, 4, 5]);
  });
});

describe('migrateData chunks (DATA-7)', () => {
  function driverWithChunks(name: 'dexie' | 'surrealdb', chunks?: ChunkStore): StorageDriver {
    return {
      name,
      async ready() {
        return true;
      },
      settings: makeSettings().store,
      chunks,
    };
  }

  it('copies the chunk corpus when both drivers can enumerate it', async () => {
    const source = driverWithChunks('dexie', makeChunks([chunk('a', [1, 2, 3]), chunk('b', [4, 5, 6])]).store);
    const targetChunks = makeChunks();
    const target = driverWithChunks('surrealdb', targetChunks.store);

    const report = await migrateData(source, target);
    expect(report.chunks).toBe(2);
    expect(report.chunksEmbeddingsDropped).toBe(0);
    expect(targetChunks.map.size).toBe(2);
  });

  it('drops mismatched embeddings during migration and reports the count', async () => {
    const source = driverWithChunks(
      'dexie',
      makeChunks([chunk('a', [1, 2, 3]), chunk('b', [4, 5, 6]), chunk('c', [7, 8])]).store,
    );
    const targetChunks = makeChunks();
    const target = driverWithChunks('surrealdb', targetChunks.store);

    const report = await migrateData(source, target);
    expect(report.chunks).toBe(3); // all 3 copied (text)
    expect(report.chunksEmbeddingsDropped).toBe(1);
    expect(targetChunks.map.get('c')?.embedding).toBeUndefined();
  });

  it('skips chunks when migrateChunks is false', async () => {
    const source = driverWithChunks('dexie', makeChunks([chunk('a', [1, 2, 3])]).store);
    const targetChunks = makeChunks();
    const target = driverWithChunks('surrealdb', targetChunks.store);

    const report = await migrateData(source, target, { migrateChunks: false });
    expect(report.chunks).toBe(0);
    expect(targetChunks.map.size).toBe(0);
    expect(report.skipped.some((s) => s.startsWith('chunks'))).toBe(true);
  });
});

describe('migrateData overwrite (DATA-2)', () => {
  it('clears the target attempt log first so a forced re-run does not duplicate', async () => {
    const source: StorageDriver = {
      name: 'dexie',
      async ready() {
        return true;
      },
      settings: makeSettings().store,
      questionResults: makeQuestionResults([qResult('q1'), qResult('q2')]).store,
    };
    const targetQ = makeQuestionResults();
    const target: StorageDriver = {
      name: 'surrealdb',
      async ready() {
        return true;
      },
      settings: makeSettings().store,
      questionResults: targetQ.store,
    };

    await migrateData(source, target, { overwrite: true });
    await migrateData(source, target, { overwrite: true });
    // Without overwrite this would be 4; the clear keeps it at 2.
    expect(await target.questionResults!.toArray()).toHaveLength(2);
  });
});

describe('buildCutoverManifest (DATA-2)', () => {
  function fullDriver(name: 'dexie' | 'surrealdb', seed: boolean, chunks?: ChunkStore): StorageDriver {
    return {
      name,
      async ready() {
        return true;
      },
      settings: makeSettings(seed ? [{ key: 'a', value: 1, updatedAt: 't' }] : []).store,
      reviewItems: makeReviewItems(seed ? [review('r1')] : []).store,
      questionResults: makeQuestionResults(seed ? [qResult('q1')] : []).store,
      masterySnapshots: makeMastery(seed ? [mastery('m1')] : []).store,
      chunks,
    };
  }

  it('is safe when every target table is empty', async () => {
    const from = fullDriver('dexie', true, makeChunks([chunk('a', [1, 2, 3])]).store);
    const to = fullDriver('surrealdb', false, makeChunks().store);

    const manifest = await buildCutoverManifest(from, to);
    expect(manifest.safe).toBe(true);
    expect(manifest.blockers).toEqual([]);
    expect(manifest.from).toBe('dexie');
    expect(manifest.to).toBe('surrealdb');
    expect(manifest.chunks.sourceCount).toBe(1);
    expect(manifest.chunks.embedded).toBe(1);
    expect(manifest.chunks.dimension).toBe(3);
    expect(manifest.chunks.migratable).toBe(true);
  });

  it('refuses (blockers) when the target already holds rows', async () => {
    const from = fullDriver('dexie', true);
    const to = fullDriver('surrealdb', true); // non-empty target

    const manifest = await buildCutoverManifest(from, to);
    expect(manifest.safe).toBe(false);
    expect(manifest.blockers.length).toBeGreaterThan(0);
    expect(manifest.blockers.some((b) => b.includes('settings'))).toBe(true);
    expect(manifest.blockers.some((b) => b.includes('questionResults'))).toBe(true);
  });

  it('flags a non-empty target chunk corpus as a blocker', async () => {
    const from = fullDriver('dexie', false, makeChunks([chunk('a')]).store);
    const to = fullDriver('surrealdb', false, makeChunks([chunk('z')]).store);

    const manifest = await buildCutoverManifest(from, to);
    expect(manifest.safe).toBe(false);
    expect(manifest.blockers.some((b) => b.includes('chunks'))).toBe(true);
    expect(manifest.chunks.targetCount).toBe(1);
  });

  it('marks chunks non-migratable when the source cannot enumerate them', async () => {
    const from = fullDriver('dexie', false); // no chunks store
    const to = fullDriver('surrealdb', false);

    const manifest = await buildCutoverManifest(from, to);
    expect(manifest.chunks.migratable).toBe(false);
    expect(manifest.chunks.sourceCount).toBe(0);
  });
});
