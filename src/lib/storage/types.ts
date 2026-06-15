import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';
import type {
  CrossDomainAttempt,
  CrossDomainMastery,
  CrossDomainReviewCard,
} from '../dataDictionary';

export interface StorageSettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

/**
 * Curriculum-chunk shape accepted by `chunks.upsert` / `chunks.bulkUpsert`.
 *
 * The on-disk Dexie row type (`CfaSourceChunk`) is intentionally a *superset*
 * of this — `domain`, `level`, `topic`, `page`, and `embedding` are tolerated
 * by IndexedDB as extra (un-indexed) fields, so old curriculum data still
 * round-trips through the new driver methods cleanly.
 */
export interface SourceChunkInput {
  id: string;
  documentId: string;
  domain: string;
  level?: string;
  topic?: string;
  text: string;
  locator: string;
  page?: number;
  /** Optional embedding vector — when present, enables vector search. */
  embedding?: number[];
}

/** A ranked chunk-search hit. */
export interface ChunkSearchResult {
  id: string;
  documentId: string;
  domain: string;
  level?: string;
  topic?: string;
  text: string;
  locator: string;
  page?: number;
  /** 0..1 unified score — higher is better. */
  score: number;
  /** Cosine similarity normalised to 0..1, when an embedding was provided. */
  vectorScore?: number;
  /** BM25 normalised to 0..1. */
  bm25Score?: number;
}

export interface ChunkSearchOptions {
  query: string;
  /** When present, vector + BM25 hybrid; when absent, BM25-only. */
  embedding?: number[];
  domain?: string;
  level?: string;
  topic?: string;
  /** Default 12. */
  limit?: number;
}

export interface ChunkStore {
  /** Upsert a single chunk (with optional embedding). */
  upsert(chunk: SourceChunkInput): Promise<void>;
  /** Bulk upsert — chunked under the hood for large imports. */
  bulkUpsert(chunks: SourceChunkInput[]): Promise<void>;
  /** Delete every chunk belonging to a single document. */
  deleteByDocument(documentId: string): Promise<void>;
  /** Hybrid (vector + BM25) or BM25-only search. */
  search(options: ChunkSearchOptions): Promise<ChunkSearchResult[]>;
}

/**
 * FSRS review-queue store.  Mirrors the historical `db.reviewItems` Dexie
 * table — keyed by the string `id` of each {@link ReviewItem}.
 */
export interface ReviewItemStore {
  get(id: string): Promise<ReviewItem | undefined>;
  put(item: ReviewItem): Promise<void>;
  bulkPut(items: ReviewItem[]): Promise<void>;
  toArray(): Promise<ReviewItem[]>;
  delete(id: string): Promise<void>;
}

/**
 * Append-only attempt log.  Mirrors the historical `db.questionResults`
 * Dexie table.  Note the row `id` is auto-assigned by the backend on `add`
 * (auto-increment in Dexie), so {@link QuestionResult} carries no `id`.
 */
export interface QuestionResultStore {
  add(result: QuestionResult): Promise<void>;
  bulkAdd(results: QuestionResult[]): Promise<void>;
  toArray(): Promise<QuestionResult[]>;
  byTopic(domain: string, topic: string): Promise<QuestionResult[]>;
  clear(): Promise<void>;
}

/**
 * Per-objective mastery snapshots.  Mirrors the historical
 * `db.masterySnapshots` Dexie table — keyed by the string `id`.
 */
export interface MasterySnapshotStore {
  get(id: string): Promise<MasterySnapshot | undefined>;
  put(snap: MasterySnapshot): Promise<void>;
  toArray(): Promise<MasterySnapshot[]>;
}

/**
 * DATA-2 — cross-domain identity / storage bridge.
 *
 * A typed common interface that maps a driver's NATIVE host shapes
 * ({@link ReviewItem}, {@link QuestionResult}, {@link MasterySnapshot}) to/from
 * the domain-agnostic canonical shapes pinned in `dataDictionary.ts`, so one
 * caller can read "what's due / how am I doing" across CFA + Quant + Excel +
 * LSAT without knowing which plane each row came from.
 *
 * This is deliberately ADDITIVE and read-first: it sits ALONGSIDE the existing
 * `reviewItems` / `questionResults` / `masterySnapshots` namespaces (which keep
 * their native shapes for existing consumers) rather than replacing them. The
 * LSAT plane is reached over HTTP via `lsatReviewBridge.ts`, NOT through this
 * driver method — this bridge covers the host side of the seam, exposing the
 * SAME canonical shapes the LSAT sidecar serializers emit so both halves merge
 * cleanly. Cross-domain WRITES are gated by the DATA-3 schema-version handshake
 * (`fetchDataSchemaAlignment` in `dataDictionary.ts`).
 */
export interface CrossDomainBridge {
  /** Read this driver's host review queue as canonical cross-domain cards. */
  reviewCards(): Promise<CrossDomainReviewCard[]>;
  /** Read this driver's host attempt log as canonical cross-domain attempts. */
  attempts(): Promise<CrossDomainAttempt[]>;
  /** Read this driver's host mastery snapshots as canonical cross-domain mastery. */
  mastery(): Promise<CrossDomainMastery[]>;
}

export interface StorageDriver {
  name: 'dexie' | 'surrealdb';
  ready(): Promise<boolean>;
  settings: {
    get(key: string): Promise<StorageSettingRow | undefined>;
    put(row: StorageSettingRow): Promise<void>;
    delete(key: string): Promise<void>;
    toArray(): Promise<StorageSettingRow[]>;
    bulkDelete(keys: string[]): Promise<void>;
    clear(): Promise<void>;
  };
  /**
   * Curriculum-chunk vector + BM25 search.  Optional on the interface because
   * future drivers (e.g. a remote-only HTTP backend) might not implement it,
   * but both shipped drivers (`dexie`, `surrealdb`) DO provide this.
   */
  chunks?: ChunkStore;
  /**
   * FSRS review queue.  Optional on the interface (like `chunks`) so callers
   * that only know about `settings` still type-check; both shipped drivers
   * (`dexie`, `surrealdb`) provide it.
   */
  reviewItems?: ReviewItemStore;
  /** Append-only question-attempt log.  Optional, provided by both drivers. */
  questionResults?: QuestionResultStore;
  /** Per-objective mastery snapshots.  Optional, provided by both drivers. */
  masterySnapshots?: MasterySnapshotStore;
  /**
   * DATA-2 — canonical cross-domain projection of this driver's host review
   * queue / attempt log / mastery (see {@link CrossDomainBridge}). Optional like
   * the other namespaces: callers feature-detect it. ADDITIVE — existing
   * `StorageDriver` consumers are unaffected.
   */
  crossDomainBridge?: CrossDomainBridge;
}

export interface StorageRegistry {
  /** The active driver — Dexie by default; can be swapped via switchDriver. */
  active: StorageDriver;
  /** Available drivers, keyed by name. */
  drivers: Record<string, StorageDriver>;
  /** Switch the active driver. Validates ready() before switching. */
  switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }>;
}
