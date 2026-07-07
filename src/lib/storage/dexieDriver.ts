import type { Table } from 'dexie';
import { createCrossDomainBridge } from '../dataDictionary';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';
import { db } from '../progressDb';
import {
  decryptSourceChunkForRead,
  decryptSourceChunksForRead,
  encryptSourceChunkForStorage,
  encryptSourceChunksForStorage,
  isSecureSourceChunk,
} from '../sourceChunkSecureVault';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  ChunkStore,
  KeyedTable,
  KeyedTableOrderOptions,
  MasterySnapshotStore,
  QuestionResultStore,
  ReviewItemStore,
  SourceChunkInput,
  StorageDriver,
  StorageSettingRow,
  StorageTransactionScope,
} from './types';

/**
 * DexieDriver — wraps the existing `db.settings` Dexie table from progressStore.
 *
 * This is the "leave" side of the strangler pattern: all current behaviour is
 * preserved through this driver.  No caller changes are required until Phase 2.
 */

/** Chunk size for `bulkUpsert` — split at this many rows per put. */
const BULK_CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// BM25 — single-pass approximation
// ---------------------------------------------------------------------------
// We tokenise on `\W+` (lowercased) and compute Okapi BM25 across the
// candidate set with k1=1.5, b=0.75 and IDF from document frequency.  The
// raw BM25 score is unbounded; we normalise to [0,1] by dividing by the
// max score within the candidate set so the hybrid blend is meaningful.

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenise(text: string): string[] {
  if (!text) return [];
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface CandidateRow {
  id: string;
  documentId: string;
  domain: string;
  level?: string;
  topic?: string;
  text: string;
  locator: string;
  page?: number;
  embedding?: number[];
  tokens: string[];
}

function computeBm25(candidates: CandidateRow[], queryTerms: string[]): number[] {
  if (candidates.length === 0 || queryTerms.length === 0) {
    return candidates.map(() => 0);
  }

  const totalDocs = candidates.length;
  const docLens = candidates.map((c) => c.tokens.length);
  const avgDl = docLens.reduce((sum, l) => sum + l, 0) / Math.max(1, totalDocs);

  // df: term -> number of candidate docs containing it
  const df = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    let n = 0;
    for (const c of candidates) {
      if (c.tokens.includes(term)) n += 1;
    }
    df.set(term, n);
  }

  // tf: per-doc term -> count
  const scores = candidates.map((c, i) => {
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      // BM25+ idf clamped at 0 so highly-common terms don't go negative.
      const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
      const dl = docLens[i];
      const numerator = f * (BM25_K1 + 1);
      const denominator = f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(1, avgDl)));
      score += idf * (numerator / denominator);
    }
    return score;
  });

  return scores;
}

function normaliseScores(raw: number[]): number[] {
  const max = raw.reduce((m, v) => (v > m ? v : m), 0);
  if (max <= 0) return raw.map(() => 0);
  return raw.map((v) => (v > 0 ? v / max : 0));
}

const chunks: ChunkStore = {
  async upsert(chunk: SourceChunkInput): Promise<void> {
    // Extra fields (`domain`, `topic`, `page`, `embedding`) ride along in the
    // IndexedDB record even though the Dexie schema only indexes the
    // historical CFA chunk fields. Dexie just stores them as-is.
    const row = await encryptSourceChunkForStorage(chunk);
    await db.sourceChunks.put(row as unknown as Parameters<typeof db.sourceChunks.put>[0]);
  },

  async bulkUpsert(input: SourceChunkInput[]): Promise<void> {
    if (input.length === 0) return;
    for (let i = 0; i < input.length; i += BULK_CHUNK_SIZE) {
      const batch = await encryptSourceChunksForStorage(input.slice(i, i + BULK_CHUNK_SIZE));
      await db.sourceChunks.bulkPut(batch as unknown as Parameters<typeof db.sourceChunks.bulkPut>[0]);
    }
  },

  async deleteByDocument(documentId: string): Promise<void> {
    await db.sourceChunks.where('documentId').equals(documentId).delete();
  },

  async exportAll(): Promise<SourceChunkInput[]> {
    // DATA-7 — full corpus read for a cross-driver migration. Read every
    // `sourceChunks` row and project it back to the `SourceChunkInput` shape,
    // carrying the embedding so the target rebuilds its vector index without
    // re-embedding. Mirrors the field projection `search()` uses; optional
    // fields are only emitted when present so a re-`bulkUpsert` round-trips
    // byte-for-byte through `canonicalJson` (no `undefined`-vs-absent drift).
    const all = await decryptSourceChunksForRead((await db.sourceChunks.toArray()) as unknown as SourceChunkInput[]);
    return all.map((raw) => {
      const r = raw as unknown as SourceChunkInput;
      const out: SourceChunkInput = {
        id: r.id,
        documentId: r.documentId,
        domain: r.domain ?? '',
        text: r.text ?? '',
        locator: r.locator ?? '',
      };
      if (r.level != null) out.level = r.level;
      if (r.topic != null) out.topic = r.topic;
      if (r.page != null) out.page = r.page;
      if (Array.isArray(r.embedding) && r.embedding.length > 0) out.embedding = r.embedding;
      return out;
    });
  },

  async search(options: ChunkSearchOptions): Promise<ChunkSearchResult[]> {
    const limit = options.limit ?? 12;
    const queryTerms = tokenise(options.query ?? '');

    // Pull all matching rows. Domain is the highest-cardinality filter — we
    // currently keep it as a JS filter because the Dexie schema doesn't index
    // `domain` (rows added via `chunks.upsert` are extra-field rows).
    const all = await decryptSourceChunksForRead((await db.sourceChunks.toArray()) as unknown as SourceChunkInput[]);
    const filtered: CandidateRow[] = [];
    for (const raw of all) {
      const r = raw as unknown as SourceChunkInput;
      if (options.domain && r.domain !== options.domain) continue;
      if (options.level && r.level !== options.level) continue;
      if (options.topic && r.topic !== options.topic) continue;
      filtered.push({
        id: r.id,
        documentId: r.documentId,
        domain: r.domain ?? '',
        level: r.level,
        topic: r.topic,
        text: r.text ?? '',
        locator: r.locator ?? '',
        page: r.page,
        embedding: r.embedding,
        tokens: tokenise(r.text ?? ''),
      });
    }

    if (filtered.length === 0) return [];

    // BM25
    const rawBm25 = computeBm25(filtered, queryTerms);
    const bm25Norm = normaliseScores(rawBm25);

    // Vector similarity (cosine) when an embedding query is provided AND any
    // candidate row carries an embedding.
    const hasQueryEmbedding = Array.isArray(options.embedding) && options.embedding.length > 0;
    const anyChunkEmbedding = filtered.some((c) => Array.isArray(c.embedding) && c.embedding!.length > 0);
    const useVector = hasQueryEmbedding && anyChunkEmbedding;
    const cosNorm = useVector
      ? filtered.map((c) => {
          if (!c.embedding || c.embedding.length === 0) return 0;
          const cos = cosineSimilarity(options.embedding!, c.embedding);
          // cosine is in [-1, 1]; map to [0, 1]
          return Math.max(0, Math.min(1, (cos + 1) / 2));
        })
      : filtered.map(() => 0);

    const results: ChunkSearchResult[] = filtered.map((c, i) => {
      const bm = bm25Norm[i] ?? 0;
      const vec = cosNorm[i] ?? 0;
      let score: number;
      if (useVector && queryTerms.length > 0) {
        score = 0.6 * vec + 0.4 * bm;
      } else if (useVector) {
        score = vec;
      } else if (queryTerms.length > 0) {
        score = bm;
      } else {
        score = 0;
      }
      return {
        id: c.id,
        documentId: c.documentId,
        domain: c.domain,
        level: c.level,
        topic: c.topic,
        text: c.text,
        locator: c.locator,
        page: c.page,
        score,
        vectorScore: useVector ? vec : undefined,
        bm25Score: queryTerms.length > 0 ? bm : undefined,
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  },
};

// ---------------------------------------------------------------------------
// reviewItems — FSRS queue (wraps db.reviewItems, keyed by string id)
// ---------------------------------------------------------------------------
const reviewItems: ReviewItemStore = {
  async get(id: string): Promise<ReviewItem | undefined> {
    return db.reviewItems.get(id);
  },

  async put(item: ReviewItem): Promise<void> {
    await db.reviewItems.put(item);
  },

  async bulkPut(items: ReviewItem[]): Promise<void> {
    if (items.length === 0) return;
    await db.reviewItems.bulkPut(items);
  },

  async toArray(): Promise<ReviewItem[]> {
    return db.reviewItems.toArray();
  },

  async delete(id: string): Promise<void> {
    await db.reviewItems.delete(id);
  },
};

// ---------------------------------------------------------------------------
// questionResults — append-only attempt log (wraps db.questionResults).
// `id` is auto-increment in Dexie, so `add` lets Dexie assign it.
//
// ANL-3 — the optional blind-review fields (`brAnswer`/`brConfidence`/`brCorrect`
// on `QuestionResult`) are NOT indexed but ride along verbatim: Dexie stores the
// whole row object and we pass it through unmodified here, so the BR capture
// reaches both `toArray()` reads and the `crossDomainBridge` projection (which
// re-exports them via `questionResultToCanonical`) without a schema change.
// ---------------------------------------------------------------------------
const questionResults: QuestionResultStore = {
  async add(result: QuestionResult): Promise<void> {
    // Cast away the auto-increment `id` (number) the Dexie row type carries —
    // QuestionResult has no `id`, and Dexie assigns one on insert. The full row
    // (including any ANL-3 BR fields) is stored verbatim.
    await db.questionResults.add(result as Parameters<typeof db.questionResults.add>[0]);
  },

  async bulkAdd(results: QuestionResult[]): Promise<void> {
    if (results.length === 0) return;
    await db.questionResults.bulkAdd(results as Parameters<typeof db.questionResults.bulkAdd>[0]);
  },

  async toArray(): Promise<QuestionResult[]> {
    return db.questionResults.toArray();
  },

  async byTopic(domain: string, topic: string): Promise<QuestionResult[]> {
    // `domain` and `topic` are both indexed; `topic` is the higher-cardinality
    // filter, so we range on it and refine `domain` in JS.
    const rows = await db.questionResults.where('topic').equals(topic).toArray();
    return rows.filter((row) => row.domain === domain);
  },

  async clear(): Promise<void> {
    await db.questionResults.clear();
  },
};

// ---------------------------------------------------------------------------
// masterySnapshots — per-objective snapshots (wraps db.masterySnapshots)
// ---------------------------------------------------------------------------
const masterySnapshots: MasterySnapshotStore = {
  async get(id: string): Promise<MasterySnapshot | undefined> {
    return db.masterySnapshots.get(id);
  },

  async put(snap: MasterySnapshot): Promise<void> {
    await db.masterySnapshots.put(snap);
  },

  async toArray(): Promise<MasterySnapshot[]> {
    return db.masterySnapshots.toArray();
  },
};

// ---------------------------------------------------------------------------
// table() — generic keyed-table primitive (DATA-1)
// ---------------------------------------------------------------------------
// Thin pass-through over `db.table(name)`. Every method is a 1:1 wrapper of the
// equivalent Dexie call so a Phase-2 reroute of `progressStore` from
// `db.<table>.<op>` to `getStorage().table('<table>').<op>` is BEHAVIOURALLY
// IDENTICAL while `getStorage()` returns this driver. We intentionally re-issue
// the SAME Dexie query the host writes today (e.g. `where(field).equals(value)`,
// `orderBy(field).reverse().offset().limit().toArray()`) rather than reading the
// whole table and filtering in JS, so index usage and ordering semantics match.

/** Build a {@link KeyedTable} backed by a Dexie `Table`, mirroring direct access. */
function createDexieTable<T>(name: string): KeyedTable<T> {
  // `db.table()` resolves lazily by name, exactly like `db.<table>`. The row /
  // key generics are erased to `any` here because the caller pins them via
  // `KeyedTable<T>`; behaviour is unchanged from the direct `db.<table>` call.
  const tbl = () => db.table(name) as unknown as Table<T, string | number>;
  const decryptRow = async (row: T | undefined): Promise<T | undefined> => {
    if (name !== 'sourceChunks' || !row) return row;
    return decryptSourceChunkForRead(row as T & { text: string }) as Promise<T | undefined>;
  };
  const decryptRows = async (rows: T[]): Promise<T[]> => {
    if (name !== 'sourceChunks') return rows;
    return decryptSourceChunksForRead(rows as Array<T & { text: string }>) as Promise<T[]>;
  };
  const encryptRow = async (row: T): Promise<T> => {
    if (name !== 'sourceChunks' || isSecureSourceChunk(row as { secureVault?: unknown })) return row;
    return encryptSourceChunkForStorage(row as T & { text: string }) as Promise<T>;
  };
  const encryptRows = async (rows: T[]): Promise<T[]> => {
    if (name !== 'sourceChunks' || rows.every((row) => isSecureSourceChunk(row as { secureVault?: unknown }))) {
      return rows;
    }
    return encryptSourceChunksForStorage(rows as Array<T & { text: string }>) as Promise<T[]>;
  };

  return {
    async get(key) {
      return decryptRow(await tbl().get(key));
    },

    async bulkGet(keys) {
      const rows = await tbl().bulkGet(keys);
      if (name !== 'sourceChunks') return rows;
      return Promise.all(rows.map((row) => decryptRow(row)));
    },

    async put(row) {
      await tbl().put(await encryptRow(row));
    },

    async bulkPut(rows) {
      if (rows.length === 0) return;
      await tbl().bulkPut(await encryptRows(rows));
    },

    async add(row) {
      // Dexie `add` assigns and returns the new primary key (the `++id` value
      // for auto-id stores). We surface it for parity with the SurrealDB driver.
      return tbl().add(await encryptRow(row));
    },

    async delete(key) {
      await tbl().delete(key);
    },

    async bulkDelete(keys) {
      await tbl().bulkDelete(keys);
    },

    async toArray() {
      return decryptRows(await tbl().toArray());
    },

    async count() {
      return tbl().count();
    },

    async clear() {
      await tbl().clear();
    },

    async whereEquals(field, value) {
      return decryptRows(await tbl().where(field).equals(value as string | number).toArray());
    },

    async whereAnyOf(field, values) {
      return decryptRows(await tbl().where(field).anyOf(values as Array<string | number>).toArray());
    },

    async orderedBy(field, options: KeyedTableOrderOptions = {}) {
      let collection = tbl().orderBy(field);
      if (options.desc) collection = collection.reverse();
      if (options.offset != null) collection = collection.offset(options.offset);
      if (options.limit != null) collection = collection.limit(options.limit);
      return decryptRows(await collection.toArray());
    },
  };
}

// ---------------------------------------------------------------------------
// transaction() — atomic read-write batch (DATA-1 Phase 3)
// ---------------------------------------------------------------------------
// Faithfully wraps `db.transaction('rw', tables, fn)`: Dexie tracks the open
// transaction in its async zone, so a `db.table(name)` access INSIDE the callback
// automatically enrols in the active transaction. The scope's `table(name)` is
// therefore just `createDexieTable(name)` — the SAME 1:1 KeyedTable wrapper the
// non-transactional `table()` returns — so a rerouted `progressStore` recorder
// is byte-identical in atomicity to the direct `db.transaction(...)` it replaces.
const dexieTxScope: StorageTransactionScope = {
  table<R>(name: string): KeyedTable<R> {
    return createDexieTable<R>(name);
  },
};

export const dexieDriver: StorageDriver = {
  name: 'dexie',

  table<T>(name: string): KeyedTable<T> {
    return createDexieTable<T>(name);
  },

  async transaction<T>(
    tables: string[],
    _mode: 'rw',
    fn: (tx: StorageTransactionScope) => Promise<T>,
  ): Promise<T> {
    // Resolve each store name to its Dexie Table so Dexie locks exactly the
    // stores the direct `db.transaction('rw', [db.x, db.y], …)` call locked.
    const dexieTables = tables.map((name) => db.table(name));
    // IMPORTANT: the transaction body MUST be an `async` function. The scope's
    // `table()` ops are 1:1 Dexie calls (which keep the transaction's PSD zone
    // alive), but `fn` reaches them through several nested `async`/`await` layers
    // (recorder → persistQuestionResult → updateMasterySnapshot). With a plain
    // `() => fn(...)` callback Dexie sees the zone drain between those hops and
    // raises PrematureCommitError ("Transaction committed too early"); wrapping
    // the body in `async () => fn(...)` keeps Dexie's zone bound across every
    // awaited op, so atomicity is preserved exactly like the prior direct
    // `db.transaction('rw', [...], async () => …)` calls.
    return db.transaction('rw', dexieTables, async () => fn(dexieTxScope));
  },

  async ready(): Promise<boolean> {
    try {
      if (db.isOpen()) return true;
      await db.open();
      return db.isOpen();
    } catch {
      return false;
    }
  },

  settings: {
    async get(key: string): Promise<StorageSettingRow | undefined> {
      const row = await db.settings.get(key);
      if (!row) return undefined;
      return { key: row.key, value: row.value, updatedAt: row.updatedAt };
    },

    async put(row: StorageSettingRow): Promise<void> {
      await db.settings.put({ key: row.key, value: row.value, updatedAt: row.updatedAt });
    },

    async delete(key: string): Promise<void> {
      await db.settings.delete(key);
    },

    async toArray(): Promise<StorageSettingRow[]> {
      const rows = await db.settings.toArray();
      return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updatedAt }));
    },

    async bulkDelete(keys: string[]): Promise<void> {
      await db.settings.bulkDelete(keys);
    },

    async clear(): Promise<void> {
      await db.settings.clear();
    },
  },

  chunks,
  reviewItems,
  questionResults,
  masterySnapshots,
  // DATA-2 / DATA-4a — canonical cross-domain projection of this driver's host
  // review queue / attempt log / mastery (read-only; never writes through the
  // native stores). The DATA-4a `useSyncProgress` hook reads these to push host
  // snapshots to the LSAT sidecar; existing consumers feature-detect the member.
  crossDomainBridge: createCrossDomainBridge({ reviewItems, questionResults, masterySnapshots }),
};
