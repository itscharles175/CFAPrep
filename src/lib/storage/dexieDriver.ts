import { db } from '../progressStore';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  ChunkStore,
  SourceChunkInput,
  StorageDriver,
  StorageSettingRow,
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
    await db.sourceChunks.put(chunk as unknown as Parameters<typeof db.sourceChunks.put>[0]);
  },

  async bulkUpsert(input: SourceChunkInput[]): Promise<void> {
    if (input.length === 0) return;
    for (let i = 0; i < input.length; i += BULK_CHUNK_SIZE) {
      const batch = input.slice(i, i + BULK_CHUNK_SIZE);
      await db.sourceChunks.bulkPut(batch as unknown as Parameters<typeof db.sourceChunks.bulkPut>[0]);
    }
  },

  async deleteByDocument(documentId: string): Promise<void> {
    await db.sourceChunks.where('documentId').equals(documentId).delete();
  },

  async search(options: ChunkSearchOptions): Promise<ChunkSearchResult[]> {
    const limit = options.limit ?? 12;
    const queryTerms = tokenise(options.query ?? '');

    // Pull all matching rows. Domain is the highest-cardinality filter — we
    // currently keep it as a JS filter because the Dexie schema doesn't index
    // `domain` (rows added via `chunks.upsert` are extra-field rows).
    const all = await db.sourceChunks.toArray();
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

export const dexieDriver: StorageDriver = {
  name: 'dexie',

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
};
