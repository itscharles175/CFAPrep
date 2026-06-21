import { Surreal, StringRecordId } from 'surrealdb';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';
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

/** Loose record shape accepted by the SurrealDB client generics. */
type SurrealRecord = { [x: string]: unknown };

const SIDECAR_URL = 'http://localhost:8000/rpc';
const SIDECAR_NAMESPACE = 'quantvault';
const SIDECAR_DATABASE = 'app';
const CONNECT_TIMEOUT_MS = 3000;
/** Vector dimension for the MTREE index. Aligned with the open-notebook
 * sidecar's default embedding model. Override here if the configured model
 * changes — schema is re-applied lazily on the next driver instantiation. */
const EMBEDDING_DIMENSION = 384;
/** k for the SurrealQL `<|k|>` KNN operator at query time. */
const VECTOR_K = 12;
const BULK_CHUNK_SIZE = 500;

/**
 * SurrealDriver — connects to the open-notebook SurrealDB sidecar (supervised
 * by the Tauri shell at localhost:8000).
 *
 * DISABLED BY DEFAULT: `ready()` returns false when the sidecar is unreachable,
 * and the registry will not switch to this driver in that case.
 */

let _client: Surreal | null = null;
let _schemaReady = false;

async function getClient(): Promise<Surreal> {
  if (_client) return _client;
  const client = new Surreal();

  await Promise.race([
    (async () => {
      await client.connect(SIDECAR_URL);
      await client.use({ namespace: SIDECAR_NAMESPACE, database: SIDECAR_DATABASE });
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`SurrealDB connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
    ),
  ]);

  _client = client;
  return _client;
}

/** Reset the cached client (used in tests or after an error). */
export function resetSurrealClient() {
  _client = null;
  _schemaReady = false;
}

// ---------------------------------------------------------------------------
// SurrealQL schema — applied lazily on first chunks.*/reviewItems.*/… call
// ---------------------------------------------------------------------------
// We define:
//   - the `chunks` table itself
//   - typed fields for filtering + payload
//   - a `quantvault_bm25` analyzer (lowercase + ascii + snowball)
//   - a SEARCH index on `text` using that analyzer with BM25 scoring
//   - an MTREE vector index on `embedding` (cosine dist, configured dimension)
//   - the `review_items`, `question_results`, and `mastery_snapshots` tables
//     (the FSRS queue, attempt log, and mastery snapshots of the unified
//     schema) with their typed fields and filter indexes
//
// All statements are idempotent via `IF NOT EXISTS` so the call is safe to
// repeat.  We only invoke it once per process (gated by `_schemaReady`).
const SCHEMA_STATEMENTS = (dim: number): string => `
  DEFINE TABLE IF NOT EXISTS chunks SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS documentId ON chunks TYPE string;
  DEFINE FIELD IF NOT EXISTS domain ON chunks TYPE string;
  DEFINE FIELD IF NOT EXISTS level ON chunks TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS topic ON chunks TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS text ON chunks TYPE string;
  DEFINE FIELD IF NOT EXISTS locator ON chunks TYPE string;
  DEFINE FIELD IF NOT EXISTS page ON chunks TYPE option<int>;
  DEFINE FIELD IF NOT EXISTS embedding ON chunks TYPE option<array<float>>;
  DEFINE ANALYZER IF NOT EXISTS quantvault_bm25 TOKENIZERS class FILTERS lowercase,ascii,snowball(english);
  DEFINE INDEX IF NOT EXISTS chunks_text_search ON chunks FIELDS text SEARCH ANALYZER quantvault_bm25 BM25 HIGHLIGHTS;
  DEFINE INDEX IF NOT EXISTS chunks_domain_idx ON chunks FIELDS domain;
  DEFINE INDEX IF NOT EXISTS chunks_doc_idx ON chunks FIELDS documentId;
  DEFINE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks FIELDS embedding MTREE DIMENSION ${dim} DIST COSINE;

  DEFINE TABLE IF NOT EXISTS review_items SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS domain ON review_items TYPE string;
  DEFINE FIELD IF NOT EXISTS topic ON review_items TYPE string;
  DEFINE FIELD IF NOT EXISTS learningObjective ON review_items TYPE string;
  DEFINE FIELD IF NOT EXISTS dueAt ON review_items TYPE string;
  DEFINE FIELD IF NOT EXISTS ease ON review_items TYPE number;
  DEFINE FIELD IF NOT EXISTS fsrsDifficulty ON review_items TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS intervalDays ON review_items TYPE number;
  DEFINE FIELD IF NOT EXISTS attempts ON review_items TYPE number;
  DEFINE FIELD IF NOT EXISTS correctStreak ON review_items TYPE number;
  DEFINE INDEX IF NOT EXISTS review_items_due_idx ON review_items FIELDS dueAt;
  DEFINE INDEX IF NOT EXISTS review_items_domain_idx ON review_items FIELDS domain;

  DEFINE TABLE IF NOT EXISTS question_results SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS domain ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS topic ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS questionId ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS learningObjective ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS correct ON question_results TYPE bool;
  DEFINE FIELD IF NOT EXISTS confidence ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS errorCategory ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS difficulty ON question_results TYPE string;
  DEFINE FIELD IF NOT EXISTS createdAt ON question_results TYPE option<string>;
  DEFINE INDEX IF NOT EXISTS question_results_topic_idx ON question_results FIELDS domain, topic;

  DEFINE TABLE IF NOT EXISTS mastery_snapshots SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS domain ON mastery_snapshots TYPE string;
  DEFINE FIELD IF NOT EXISTS topic ON mastery_snapshots TYPE string;
  DEFINE FIELD IF NOT EXISTS learningObjective ON mastery_snapshots TYPE string;
  DEFINE FIELD IF NOT EXISTS score ON mastery_snapshots TYPE number;
  DEFINE FIELD IF NOT EXISTS attempts ON mastery_snapshots TYPE number;
  DEFINE FIELD IF NOT EXISTS lastAttemptAt ON mastery_snapshots TYPE string;
  DEFINE INDEX IF NOT EXISTS mastery_snapshots_topic_idx ON mastery_snapshots FIELDS domain, topic;

  DEFINE TABLE IF NOT EXISTS setting SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS key ON setting TYPE string;
  DEFINE FIELD IF NOT EXISTS updatedAt ON setting TYPE string;
  DEFINE INDEX IF NOT EXISTS setting_key_idx ON setting FIELDS key;
`;

async function ensureSchema(client: Surreal): Promise<void> {
  if (_schemaReady) return;
  await client.query(SCHEMA_STATEMENTS(EMBEDDING_DIMENSION));
  _schemaReady = true;
}

// ---------------------------------------------------------------------------
// SurrealQL helpers
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary host id into a SurrealDB record-id-safe slug.
 *
 * This is a strict, reversible percent-escaping over the UTF-8 bytes of the
 * input: every character outside the SurrealDB-id-safe set `[A-Za-z0-9_-]`
 * (including `%` itself, so the encoding stays unambiguous) is replaced by one
 * `%XX` group per UTF-8 byte, using UPPERCASE hex.
 *
 * Unlike the previous `replace(/[^a-zA-Z0-9_-]/g, '_')` scheme — which mapped
 * many distinct ids onto the same slug — this encoding is INJECTIVE: distinct
 * inputs always produce distinct outputs (e.g. `a::b` -> `a%3A%3Ab` while
 * `a:b` -> `a%3Ab`). That prevents silent cross-domain overwrites of FSRS-queue
 * and mastery-snapshot rows whose ids are colon-delimited (`domain::topic::lo`).
 *
 * The output uses only `[A-Za-z0-9_%-]`, all of which are valid inside a
 * SurrealDB string record id. Pair with {@link decodeId} for the inverse.
 */
export function sanitiseId(id: string): string {
  const bytes = new TextEncoder().encode(id);
  let out = '';
  for (const byte of bytes) {
    // Safe set: 0-9 (0x30-0x39), A-Z (0x41-0x5A), a-z (0x61-0x7A), '-' (0x2D), '_' (0x5F).
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x5f
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
    }
  }
  return out;
}

/** Inverse of {@link sanitiseId}: recover the original host id from its slug. */
export function decodeId(slug: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < slug.length; i += 1) {
    const ch = slug[i];
    if (ch === '%') {
      bytes.push(parseInt(slug.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function encodeSettingKey(key: string): string {
  const bytes = new TextEncoder().encode(key);
  return `k_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function settingRecordId(key: string): StringRecordId {
  return new StringRecordId(`setting:${encodeSettingKey(key)}`);
}

function buildSearchQuery(opts: { hasEmbedding: boolean; hasQuery: boolean; filters: string[] }): string {
  const { hasEmbedding, hasQuery, filters } = opts;

  const selectParts = ['*'];
  if (hasQuery) selectParts.push('search::score(0) AS bm25');
  if (hasEmbedding) selectParts.push('vector::similarity::cosine(embedding, $embedding) AS vector_score');

  const whereParts: string[] = [...filters];
  if (hasQuery) whereParts.push('text @@ $query');
  if (hasEmbedding) whereParts.push(`embedding <|${VECTOR_K}|> $embedding`);

  const orderParts: string[] = [];
  if (hasEmbedding) orderParts.push('vector_score DESC');
  if (hasQuery) orderParts.push('bm25 DESC');

  return [
    `SELECT ${selectParts.join(', ')}`,
    'FROM chunks',
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '',
    orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : '',
    'LIMIT $limit',
  ]
    .filter(Boolean)
    .join(' ');
}

function normaliseMax(values: number[]): number[] {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => (v > 0 ? v / max : 0));
}

const chunks: ChunkStore = {
  async upsert(chunk: SourceChunkInput): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    const rid = new StringRecordId(`chunks:${sanitiseId(chunk.id)}`);
    await client.upsert(rid, { ...chunk } as unknown as SurrealRecord);
  },

  async bulkUpsert(input: SourceChunkInput[]): Promise<void> {
    if (input.length === 0) return;
    const client = await getClient();
    await ensureSchema(client);

    for (let i = 0; i < input.length; i += BULK_CHUNK_SIZE) {
      const batch = input.slice(i, i + BULK_CHUNK_SIZE).map((c) => ({
        ...c,
        // Stamp the explicit record id alongside the payload so the SurrealQL
        // FOR loop can build the record reference deterministically.
        _id: sanitiseId(c.id),
      }));
      await client.query(
        `FOR $c IN $chunks { UPSERT type::thing('chunks', $c._id) MERGE $c; };`,
        { chunks: batch },
      );
    }
  },

  async deleteByDocument(documentId: string): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    await client.query('DELETE chunks WHERE documentId = $doc;', { doc: documentId });
  },

  async search(options: ChunkSearchOptions): Promise<ChunkSearchResult[]> {
    const client = await getClient();
    await ensureSchema(client);

    const limit = options.limit ?? 12;
    const query = (options.query ?? '').trim();
    const hasQuery = query.length > 0;
    const hasEmbedding = Array.isArray(options.embedding) && options.embedding.length > 0;

    const filters: string[] = [];
    const binds: Record<string, unknown> = { limit };
    if (hasQuery) binds.query = query;
    if (hasEmbedding) binds.embedding = options.embedding;
    if (options.domain) {
      filters.push('domain = $domain');
      binds.domain = options.domain;
    }
    if (options.level) {
      filters.push('level = $level');
      binds.level = options.level;
    }
    if (options.topic) {
      filters.push('topic = $topic');
      binds.topic = options.topic;
    }

    const sql = buildSearchQuery({ hasEmbedding, hasQuery, filters });
    const result = await client.query<[SurrealRecord[]]>(sql, binds);
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];

    // Normalise both score channels across the candidate slice so a single
    // hybrid number reads in [0,1].
    const bm25Raw = rows.map((r) => Number(r['bm25'] ?? 0));
    const vecRaw = rows.map((r) => {
      const v = r['vector_score'];
      if (typeof v === 'number') return Math.max(0, Math.min(1, (v + 1) / 2));
      // Some surreal builds return distance instead of similarity — fall back.
      const d = r['vector_distance'];
      if (typeof d === 'number') return Math.max(0, Math.min(1, 1 - d));
      return 0;
    });
    const bm25Norm = normaliseMax(bm25Raw);
    const vecNorm = normaliseMax(vecRaw);

    const mapped: ChunkSearchResult[] = rows.map((r, i) => {
      const bm = bm25Norm[i] ?? 0;
      const vec = vecNorm[i] ?? 0;
      let score: number;
      if (hasEmbedding && hasQuery) score = 0.6 * vec + 0.4 * bm;
      else if (hasEmbedding) score = vec;
      else if (hasQuery) score = bm;
      else score = 0;
      const idValue = r['id'];
      const id = typeof idValue === 'string' ? idValue : String(idValue ?? '');
      return {
        id,
        documentId: String(r['documentId'] ?? ''),
        domain: String(r['domain'] ?? ''),
        level: r['level'] != null ? String(r['level']) : undefined,
        topic: r['topic'] != null ? String(r['topic']) : undefined,
        text: String(r['text'] ?? ''),
        locator: String(r['locator'] ?? ''),
        page: typeof r['page'] === 'number' ? (r['page'] as number) : undefined,
        score,
        vectorScore: hasEmbedding ? vec : undefined,
        bm25Score: hasQuery ? bm : undefined,
      };
    });

    mapped.sort((a, b) => b.score - a.score);
    return mapped.slice(0, limit);
  },
};

// ---------------------------------------------------------------------------
// reviewItems — FSRS queue (table `review_items`, keyed by string id)
// ---------------------------------------------------------------------------
const reviewItems: ReviewItemStore = {
  async get(id: string): Promise<ReviewItem | undefined> {
    const client = await getClient();
    await ensureSchema(client);
    const result = await client.select<SurrealRecord>(new StringRecordId(`review_items:${sanitiseId(id)}`));
    const row = Array.isArray(result) ? result[0] : (result as SurrealRecord | undefined);
    if (!row) return undefined;
    return { ...(row as unknown as ReviewItem), id };
  },

  async put(item: ReviewItem): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    await client.upsert(new StringRecordId(`review_items:${sanitiseId(item.id)}`), { ...item } as unknown as SurrealRecord);
  },

  async bulkPut(items: ReviewItem[]): Promise<void> {
    if (items.length === 0) return;
    const client = await getClient();
    await ensureSchema(client);
    for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE) {
      const batch = items.slice(i, i + BULK_CHUNK_SIZE).map((item) => ({ ...item, _id: sanitiseId(item.id) }));
      await client.query('FOR $r IN $rows { UPSERT type::thing(\'review_items\', $r._id) MERGE $r; };', { rows: batch });
    }
  },

  async toArray(): Promise<ReviewItem[]> {
    const client = await getClient();
    await ensureSchema(client);
    const rows = await client.select<SurrealRecord>('review_items');
    return (Array.isArray(rows) ? rows : []) as unknown as ReviewItem[];
  },

  async delete(id: string): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    await client.delete(new StringRecordId(`review_items:${sanitiseId(id)}`));
  },
};

// ---------------------------------------------------------------------------
// questionResults — append-only attempt log (table `question_results`).
// SurrealDB auto-assigns a random record id on CREATE, matching the Dexie
// auto-increment behaviour (callers never supply an id).
// ---------------------------------------------------------------------------
const questionResults: QuestionResultStore = {
  async add(result: QuestionResult): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    await client.create('question_results', { ...result } as unknown as SurrealRecord);
  },

  async bulkAdd(results: QuestionResult[]): Promise<void> {
    if (results.length === 0) return;
    const client = await getClient();
    await ensureSchema(client);
    for (let i = 0; i < results.length; i += BULK_CHUNK_SIZE) {
      const batch = results.slice(i, i + BULK_CHUNK_SIZE);
      await client.query('FOR $q IN $rows { CREATE question_results CONTENT $q; };', { rows: batch });
    }
  },

  async toArray(): Promise<QuestionResult[]> {
    const client = await getClient();
    await ensureSchema(client);
    const rows = await client.select<SurrealRecord>('question_results');
    return (Array.isArray(rows) ? rows : []) as unknown as QuestionResult[];
  },

  async byTopic(domain: string, topic: string): Promise<QuestionResult[]> {
    const client = await getClient();
    await ensureSchema(client);
    const result = await client.query<[SurrealRecord[]]>(
      'SELECT * FROM question_results WHERE domain = $d AND topic = $t',
      { d: domain, t: topic },
    );
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
    return rows as unknown as QuestionResult[];
  },

  async clear(): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    await client.delete('question_results');
  },
};

// ---------------------------------------------------------------------------
// masterySnapshots — per-objective snapshots (table `mastery_snapshots`)
// ---------------------------------------------------------------------------
const masterySnapshots: MasterySnapshotStore = {
  async get(id: string): Promise<MasterySnapshot | undefined> {
    const client = await getClient();
    await ensureSchema(client);
    const result = await client.select<SurrealRecord>(new StringRecordId(`mastery_snapshots:${sanitiseId(id)}`));
    const row = Array.isArray(result) ? result[0] : (result as SurrealRecord | undefined);
    if (!row) return undefined;
    return { ...(row as unknown as MasterySnapshot), id };
  },

  async put(snap: MasterySnapshot): Promise<void> {
    const client = await getClient();
    await ensureSchema(client);
    await client.upsert(new StringRecordId(`mastery_snapshots:${sanitiseId(snap.id)}`), { ...snap } as unknown as SurrealRecord);
  },

  async toArray(): Promise<MasterySnapshot[]> {
    const client = await getClient();
    await ensureSchema(client);
    const rows = await client.select<SurrealRecord>('mastery_snapshots');
    return (Array.isArray(rows) ? rows : []) as unknown as MasterySnapshot[];
  },
};

// ---------------------------------------------------------------------------
// table() — generic keyed-table primitive (DATA-1)
// ---------------------------------------------------------------------------
// Maps a host table name to a SurrealDB table, mirroring the namespace methods
// above: keyed CRUD goes through `StringRecordId(`<table>:<sanitiseId(key)>`)`
// (so colon-delimited host ids never collide — see `sanitiseId`), bulk writes
// use the same `FOR … UPSERT type::thing(...)` loop as `reviewItems.bulkPut`,
// and the query surface translates to SurrealQL. Offline-safe to CONSTRUCT (no
// connection is opened until a method runs).
//
// Key handling parallels the existing methods exactly:
//   - `get` re-stamps the host `id` from the lookup key (Surreal stores a
//     record reference, not the host string id).
//   - whole-table reads (`toArray` / `orderedBy` / `whereEquals` / `whereAnyOf`)
//     return rows AS-STORED, WITHOUT re-stamping the host id — matching
//     `reviewItems.toArray()` / `masterySnapshots.toArray()` today.
//   - `put` keys off `row.id` (the Dexie primary key for keyed stores).
//   - `add` uses `create()` so SurrealDB assigns a random record id, mirroring
//     Dexie auto-increment for append-only stores.

/** Read the host key off a row (Dexie keyed stores use the `id` primary key). */
function rowKeyOf(row: unknown): string {
  const id = (row as { id?: unknown })?.id;
  return String(id);
}

/** Build a {@link KeyedTable} backed by a SurrealDB table. */
function createSurrealTable<T>(name: string): KeyedTable<T> {
  const rid = (key: string | number) => new StringRecordId(`${name}:${sanitiseId(String(key))}`);

  return {
    async get(key) {
      const client = await getClient();
      await ensureSchema(client);
      const result = await client.select<SurrealRecord>(rid(key));
      const row = Array.isArray(result) ? result[0] : (result as SurrealRecord | undefined);
      if (!row) return undefined;
      // Re-stamp the host key (Surreal stored a record reference, not it).
      return { ...(row as unknown as T), id: key } as T;
    },

    async bulkGet(keys) {
      const client = await getClient();
      await ensureSchema(client);
      // One select per key keeps slot alignment (undefined where absent), which
      // is the contract `db.<table>.bulkGet(keys)` provides to the import path.
      return Promise.all(
        keys.map(async (key) => {
          const result = await client.select<SurrealRecord>(rid(key));
          const row = Array.isArray(result) ? result[0] : (result as SurrealRecord | undefined);
          if (!row) return undefined;
          return { ...(row as unknown as T), id: key } as T;
        }),
      );
    },

    async put(row) {
      const client = await getClient();
      await ensureSchema(client);
      await client.upsert(rid(rowKeyOf(row)), { ...(row as unknown as SurrealRecord) });
    },

    async bulkPut(rows) {
      if (rows.length === 0) return;
      const client = await getClient();
      await ensureSchema(client);
      for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
        const batch = rows
          .slice(i, i + BULK_CHUNK_SIZE)
          .map((row) => ({ ...(row as unknown as SurrealRecord), _id: sanitiseId(rowKeyOf(row)) }));
        await client.query(`FOR $r IN $rows { UPSERT type::thing('${name}', $r._id) MERGE $r; };`, {
          rows: batch,
        });
      }
    },

    async add(row) {
      const client = await getClient();
      await ensureSchema(client);
      // CREATE assigns a random record id, matching Dexie auto-increment.
      await client.create(name, { ...(row as unknown as SurrealRecord) });
    },

    async delete(key) {
      const client = await getClient();
      await ensureSchema(client);
      await client.delete(rid(key));
    },

    async bulkDelete(keys) {
      const client = await getClient();
      await ensureSchema(client);
      await Promise.all(keys.map((key) => client.delete(rid(key))));
    },

    async toArray() {
      const client = await getClient();
      await ensureSchema(client);
      const rows = await client.select<SurrealRecord>(name);
      return (Array.isArray(rows) ? rows : []) as unknown as T[];
    },

    async count() {
      const client = await getClient();
      await ensureSchema(client);
      const result = await client.query<[Array<{ count: number }>]>(
        `SELECT count() AS count FROM ${name} GROUP ALL;`,
      );
      const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
      return rows.length > 0 ? Number(rows[0]?.count ?? 0) : 0;
    },

    async clear() {
      const client = await getClient();
      await ensureSchema(client);
      await client.delete(name);
    },

    async whereEquals(field, value) {
      const client = await getClient();
      await ensureSchema(client);
      const result = await client.query<[SurrealRecord[]]>(
        `SELECT * FROM ${name} WHERE ${field} = $value;`,
        { value },
      );
      const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
      return rows as unknown as T[];
    },

    async whereAnyOf(field, values) {
      const client = await getClient();
      await ensureSchema(client);
      const result = await client.query<[SurrealRecord[]]>(
        `SELECT * FROM ${name} WHERE ${field} IN $values;`,
        { values },
      );
      const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
      return rows as unknown as T[];
    },

    async orderedBy(field, options: KeyedTableOrderOptions = {}) {
      const client = await getClient();
      await ensureSchema(client);
      const parts = [`SELECT * FROM ${name}`, `ORDER BY ${field} ${options.desc ? 'DESC' : 'ASC'}`];
      if (options.limit != null) parts.push(`LIMIT ${Number(options.limit)}`);
      // SurrealQL START offsets AFTER LIMIT in clause order.
      if (options.offset != null) parts.push(`START ${Number(options.offset)}`);
      const result = await client.query<[SurrealRecord[]]>(`${parts.join(' ')};`);
      const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
      return rows as unknown as T[];
    },
  };
}

// ---------------------------------------------------------------------------
// transaction() — atomic read-write batch (DATA-1 Phase 3), best-effort
// ---------------------------------------------------------------------------
// runtime-verify-gated: this driver is NOT exercised today (Dexie is the active
// backend), so the transaction path here is wire-ready but UNVERIFIED against a
// live :8000 sidecar.
//
// SurrealDB's wire protocol DOES expose BEGIN/COMMIT/CANCEL TRANSACTION, but the
// JS client's keyed-CRUD methods (`upsert`/`create`/`delete`/`select`) issue
// individual RPCs that do NOT cleanly compose into one SurrealQL transaction
// block from the client side — wrapping arbitrary callback ops in a single
// BEGIN…COMMIT would require re-expressing every op as raw SurrealQL bound into
// one `query()` string, which the generic `KeyedTable` surface does not model.
//
// So this is SEQUENTIAL best-effort: the scope's `table(name)` is the SAME
// non-transactional `createSurrealTable(name)`, and `fn` runs its ops in order.
// It preserves ORDER and result identity (so the callback's return value and the
// rows it writes match the Dexie path) but NOT cross-table rollback on a
// mid-batch failure. The `tables` list is advisory here (the connection is the
// boundary). A future hardening pass can replace this with a server-side
// BEGIN…COMMIT once the op surface is expressible as composed SurrealQL.
const surrealTxScope: StorageTransactionScope = {
  table<R>(name: string): KeyedTable<R> {
    return createSurrealTable<R>(name);
  },
};

export const surrealDriver: StorageDriver = {
  name: 'surrealdb',

  table<T>(name: string): KeyedTable<T> {
    return createSurrealTable<T>(name);
  },

  async transaction<T>(
    _tables: string[],
    _mode: 'rw',
    fn: (tx: StorageTransactionScope) => Promise<T>,
  ): Promise<T> {
    // runtime-verify-gated best-effort (see block comment above): sequential,
    // order-preserving, no cross-table rollback. Open the connection up front so
    // a connect failure surfaces before any partial write (mirrors the named
    // methods, which `getClient()` + `ensureSchema()` on each op).
    const client = await getClient();
    await ensureSchema(client);
    return fn(surrealTxScope);
  },

  async ready(): Promise<boolean> {
    try {
      const client = await getClient();
      await client.ping();
      return true;
    } catch {
      resetSurrealClient();
      return false;
    }
  },

  settings: {
    async get(key: string): Promise<StorageSettingRow | undefined> {
      const client = await getClient();
      await ensureSchema(client);
      const result = await client.select<SurrealRecord>(settingRecordId(key));
      const row = Array.isArray(result) ? result[0] : (result as SurrealRecord | undefined);
      if (!row || typeof row['key'] !== 'string') return undefined;
      return { key: row['key'] as string, value: row['value'], updatedAt: row['updatedAt'] as string };
    },

    async put(row: StorageSettingRow): Promise<void> {
      const client = await getClient();
      await ensureSchema(client);
      await client.upsert(settingRecordId(row.key), { key: row.key, value: row.value, updatedAt: row.updatedAt });
    },

    async delete(key: string): Promise<void> {
      const client = await getClient();
      await ensureSchema(client);
      await client.delete(settingRecordId(key));
    },

    async toArray(): Promise<StorageSettingRow[]> {
      const client = await getClient();
      await ensureSchema(client);
      const rows = await client.select<SurrealRecord>('setting');
      const arr = Array.isArray(rows) ? rows : [];
      return arr
        .filter((row) => row && typeof row['key'] === 'string')
        .map((row) => ({ key: row['key'] as string, value: row['value'], updatedAt: row['updatedAt'] as string }));
    },

    async bulkDelete(keys: string[]): Promise<void> {
      const client = await getClient();
      await ensureSchema(client);
      await Promise.all(keys.map((key) => client.delete(settingRecordId(key))));
    },

    async clear(): Promise<void> {
      const client = await getClient();
      await ensureSchema(client);
      await client.delete('setting');
    },
  },

  chunks,
  reviewItems,
  questionResults,
  masterySnapshots,
};
