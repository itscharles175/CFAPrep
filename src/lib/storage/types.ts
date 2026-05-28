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
}

export interface StorageRegistry {
  /** The active driver — Dexie by default; can be swapped via switchDriver. */
  active: StorageDriver;
  /** Available drivers, keyed by name. */
  drivers: Record<string, StorageDriver>;
  /** Switch the active driver. Validates ready() before switching. */
  switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }>;
}
