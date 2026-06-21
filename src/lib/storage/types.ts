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

/**
 * Options for the ordered read of {@link KeyedTable.orderedBy}.
 *
 * Mirrors the Dexie `orderBy(field).reverse?().offset?(n).limit?(n).toArray()`
 * chain that `progressStore` uses pervasively (e.g. the
 * `db.<table>.orderBy('createdAt').reverse().toArray()` /
 * `.reverse().limit(10)` / `.reverse().offset(10)` reads in
 * `getProgressSummary`, `getResultArtifacts`, `listRollbackSnapshots`,
 * `getVaultHealthReport`). Collapsing those three modifiers into one options
 * bag keeps the primitive small while covering every ordered shape the host
 * actually issues.
 */
export interface KeyedTableOrderOptions {
  /** Descending order (Dexie `.reverse()`). Default ascending. */
  desc?: boolean;
  /** Skip the first N rows (Dexie `.offset(n)`). */
  offset?: number;
  /** Cap the result to N rows (Dexie `.limit(n)`); `1` mirrors `.first()`. */
  limit?: number;
}

/**
 * DATA-1 — a generic, typed, keyed-table primitive.
 *
 * This is the driver-agnostic shape that the Phase-2 reroute of `progressStore`
 * (~308 direct `db.<table>` accesses across ~36 Dexie tables) will target. The
 * surface is derived from a SURVEY of how `progressStore` actually queries
 * Dexie today — it is deliberately the *smallest faithful* cover of the real
 * call sites, NOT the full Dexie API:
 *
 *   - `get` / `put` / `delete` / `clear` / `toArray` / `count`  — keyed CRUD +
 *     scans (`db.X.get`, `.put`, `.delete`, `.clear`, `.toArray`, `.count`).
 *   - `add`            — append-only insert into an auto-id store (Dexie `++id`
 *                        tables: `questionResults`, `quizAttempts`,
 *                        `mockAttempts`, `studySessions`, …). The backend
 *                        assigns the key; callers never supply one.
 *   - `bulkPut`        — bulk upsert used by the import / migration path
 *                        (`db.X.bulkPut(rows)` across every store).
 *   - `bulkGet`        — bulk keyed read used by import-dedupe / conflict
 *                        detection (`db.X.bulkGet(keys)` in
 *                        `filterKeepExisting` / `detectImportConflicts`).
 *   - `bulkDelete`     — bulk keyed delete (Dexie `db.X.bulkDelete`; mirrors the
 *                        existing `settings.bulkDelete` namespace method).
 *   - `whereEquals`    — single indexed-equality read
 *                        (`db.questionResults.where('learningObjective')
 *                        .equals(v)…toArray()` in `updateMasterySnapshot`, and
 *                        `db.sourceChunks.where('documentId').equals(v)` in the
 *                        chunk store). The post-`.equals` JS `.filter(...)` the
 *                        host adds stays in the caller — it runs on the returned
 *                        array, so the driver only needs the indexed equality.
 *   - `whereAnyOf`     — single indexed set-membership read (Dexie
 *                        `where(field).anyOf(values)`). Not on a hot
 *                        `progressStore` path today, but it is the natural bulk
 *                        companion to `whereEquals`, is trivially expressible on
 *                        both backends, and the migration / cross-domain reads
 *                        want it — so it is included rather than faked later.
 *   - `orderedBy`      — ordered (optionally reversed / offset / limited) scan
 *                        (see {@link KeyedTableOrderOptions}).
 *
 * @typeParam T - the row shape. Rows are stored verbatim; the backend does not
 *   reshape them. `string | number` keys cover both Dexie keyed (`id: string`)
 *   and auto-id (`id?: number`) tables.
 *
 * NB on key restoration: like the existing namespace methods, single-row reads
 * (`get`) restore the original host key, but whole-table reads (`toArray`,
 * `orderedBy`, `whereEquals`, `whereAnyOf`) return rows AS-STORED. On Dexie the
 * key is the primary key so it always round-trips; on SurrealDB a record
 * reference is stored and the host key is only re-stamped on `get`. Callers that
 * need the key on a scanned row must read a field, not rely on a re-stamp — this
 * matches today's `reviewItems.toArray()` / `masterySnapshots.toArray()`
 * behaviour exactly, so a Phase-2 reroute is behaviour-preserving.
 */
export interface KeyedTable<T> {
  /** Keyed read; `undefined` when absent. Restores the host key on the row. */
  get(key: string | number): Promise<T | undefined>;
  /** Bulk keyed read; one slot per requested key, `undefined` where absent. */
  bulkGet(keys: Array<string | number>): Promise<Array<T | undefined>>;
  /** Keyed upsert (Dexie `put`). */
  put(row: T): Promise<void>;
  /** Bulk keyed upsert (Dexie `bulkPut`); chunked internally for large writes. */
  bulkPut(rows: T[]): Promise<void>;
  /**
   * Append-only insert into an auto-id table (Dexie `add`). The backend assigns
   * the primary key, so callers pass a row WITHOUT one. Use `put` for keyed
   * tables. Resolves to the assigned key when the backend exposes it.
   */
  add(row: T): Promise<string | number | void>;
  /** Keyed delete; a no-op when the key is absent. */
  delete(key: string | number): Promise<void>;
  /** Bulk keyed delete (Dexie `bulkDelete`). */
  bulkDelete(keys: Array<string | number>): Promise<void>;
  /** Full-table scan, rows as-stored. */
  toArray(): Promise<T[]>;
  /** Row count. */
  count(): Promise<number>;
  /** Empty the table. */
  clear(): Promise<void>;
  /** Rows where `field` strictly equals `value` (Dexie `where(field).equals`). */
  whereEquals(field: keyof T & string, value: unknown): Promise<T[]>;
  /** Rows where `field` is one of `values` (Dexie `where(field).anyOf`). */
  whereAnyOf(field: keyof T & string, values: unknown[]): Promise<T[]>;
  /** Ordered (optionally reversed / offset / limited) scan. */
  orderedBy(field: keyof T & string, options?: KeyedTableOrderOptions): Promise<T[]>;
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
  /**
   * DATA-1 — generic typed access to ANY backend table by name (see
   * {@link KeyedTable}). This is the foundation the Phase-2 `progressStore`
   * reroute targets: instead of `db.<table>.<op>` it will call
   * `getStorage().table<RowType>('<table>').<op>`. Optional on the interface
   * (like `chunks` / `reviewItems`) so callers feature-detect it; both shipped
   * drivers (`dexie`, `surrealdb`) provide it. ADDITIVE — existing namespace
   * methods and their consumers are untouched.
   *
   * @typeParam T - the row shape for the named table.
   * @param name - the backend table name (the Dexie store name; the SurrealDB
   *   driver maps it to a SurrealDB table, sanitising record ids).
   */
  table?<T>(name: string): KeyedTable<T>;
}

export interface StorageRegistry {
  /** The active driver — Dexie by default; can be swapped via switchDriver. */
  active: StorageDriver;
  /** Available drivers, keyed by name. */
  drivers: Record<string, StorageDriver>;
  /** Switch the active driver. Validates ready() before switching. */
  switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }>;
}
