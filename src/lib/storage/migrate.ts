import type { SourceChunkInput, StorageDriver } from './types';

/**
 * Result of copying data between two storage drivers.
 *
 * Counts are per-namespace rows successfully written to the target.
 * `skipped` names namespaces that could not be migrated generically through
 * the driver interface (e.g. `chunks` when the source driver can't enumerate
 * its corpus — those are re-derived from `sourceDocuments` on re-ingestion).
 */
export interface MigrationReport {
  settings: number;
  reviewItems: number;
  questionResults: number;
  masterySnapshots: number;
  /** DATA-7 — chunks copied into the target (with or without embedding). */
  chunks: number;
  /**
   * DATA-7 — chunks whose embedding the dimension guard dropped before the copy
   * (embedding length didn't match the enforced corpus dimension). The text is
   * still copied so BM25 search keeps working; only the wrong-dimension vector
   * is omitted so it can't corrupt the target's MTREE index.
   */
  chunksEmbeddingsDropped: number;
  skipped: string[];
}

/** Options for {@link migrateData}. All default to the historical behaviour. */
export interface MigrateOptions {
  /**
   * DATA-2 — clear the target's append-only attempt log (`questionResults`)
   * before copying so a forced re-run can't DUPLICATE it. Default `false`: the
   * cutover path proves the target is empty via {@link buildCutoverManifest}
   * before calling, and the read-through re-warm path clears the log itself. The
   * keyed namespaces (settings / reviewItems / masterySnapshots / chunks) use
   * upsert semantics and are idempotent regardless, so only the append-only log
   * needs clearing for a repeatable migration.
   */
  overwrite?: boolean;
  /**
   * DATA-7 — also copy the chunk/embedding corpus (dimension-guarded). Default
   * `true` so a cutover is chunk-complete (no hours of re-embedding). The
   * read-through re-warm path passes `false` to keep its historical
   * settings/reviewItems/questionResults/mastery scope and avoid a heavy chunk
   * copy on every recovery.
   */
  migrateChunks?: boolean;
  /**
   * DATA-7 — the vector dimension to enforce on chunk embeddings (the target's
   * MTREE dimension). When omitted, the corpus's MODAL embedding length is used,
   * so mixed-dimension embeddings can never reach the index. Embeddings whose
   * length differs are dropped (text kept) and counted in
   * {@link MigrationReport.chunksEmbeddingsDropped}.
   */
  embeddingDimension?: number;
}

/** Outcome of {@link guardChunkEmbeddings}. */
export interface ChunkGuardResult {
  /** Chunks ready to write — wrong-dimension embeddings stripped (text kept). */
  chunks: SourceChunkInput[];
  /** How many chunks kept their embedding. */
  embedded: number;
  /** How many chunks had a mismatched embedding dropped. */
  dropped: number;
  /** The enforced corpus dimension, or `null` when no chunk carried one. */
  dimension: number | null;
}

/**
 * DATA-7 dimension guard — return a chunk set safe to feed into a vector index.
 *
 * A migration that streamed mixed-length embeddings into an MTREE index defined
 * for a single dimension would error or silently corrupt the index. This guard
 * pins ONE dimension for the whole corpus and strips any embedding that doesn't
 * match it (keeping the chunk's text so BM25 still works), so the target rebuilds
 * a clean, uniform vector index.
 *
 * The enforced dimension is `expectedDimension` when given (the target MTREE's
 * dimension); otherwise the MODAL (most common) embedding length across the
 * corpus, so the dominant embedding model wins and stray vectors are dropped.
 * Pure — never mutates the input rows.
 */
export function guardChunkEmbeddings(
  chunks: SourceChunkInput[],
  expectedDimension?: number,
): ChunkGuardResult {
  // Tally embedding lengths present in the corpus.
  const lengthCounts = new Map<number, number>();
  for (const c of chunks) {
    if (Array.isArray(c.embedding) && c.embedding.length > 0) {
      lengthCounts.set(c.embedding.length, (lengthCounts.get(c.embedding.length) ?? 0) + 1);
    }
  }

  if (lengthCounts.size === 0) {
    // No embeddings anywhere — nothing to guard; copy the text verbatim.
    return { chunks: chunks.map((c) => ({ ...c })), embedded: 0, dropped: 0, dimension: null };
  }

  // Pin the dimension: explicit override wins; else the modal embedding length.
  let dimension: number;
  if (typeof expectedDimension === 'number' && expectedDimension > 0) {
    dimension = expectedDimension;
  } else {
    let bestLen = 0;
    let bestCount = -1;
    for (const [len, count] of lengthCounts) {
      // Tie-break on the larger dimension for determinism.
      if (count > bestCount || (count === bestCount && len > bestLen)) {
        bestLen = len;
        bestCount = count;
      }
    }
    dimension = bestLen;
  }

  let embedded = 0;
  let dropped = 0;
  const out = chunks.map((c) => {
    if (Array.isArray(c.embedding) && c.embedding.length > 0) {
      if (c.embedding.length === dimension) {
        embedded += 1;
        return { ...c };
      }
      // Mismatched vector — strip it, keep the text.
      dropped += 1;
      const { embedding: _embedding, ...rest } = c;
      return { ...rest };
    }
    return { ...c };
  });

  return { chunks: out, embedded, dropped, dimension };
}

/**
 * Copy every readable namespace from `from` into `to`.
 *
 * Idempotent for keyed namespaces (settings/reviewItems/masterySnapshots/chunks
 * use upsert semantics). `questionResults` is an append-only log, so a re-run
 * would duplicate rows unless `options.overwrite` clears the target log first —
 * callers either migrate into a fresh target (guaranteed by
 * {@link buildCutoverManifest}'s safe-check) or pass `overwrite`.
 *
 * SCOPE (deliberate): this copies the CORE vault namespaces — settings,
 * reviewItems, questionResults, masterySnapshots — plus chunks (DATA-7). It does
 * NOT copy the host's DERIVED telemetry stores (`abilitySnapshots`, `studyTrail`
 * — recomputable from the attempt log, like chunks are re-derivable from
 * sourceDocuments) nor the append-only recorder stores (`quizAttempts`,
 * `studySessions`, `reviewEvents`, `confidenceCalibration`, …). Those are either
 * reconstructible or outside the core-vault contract, so {@link verifyMigration}
 * (the rollback gate) deliberately excludes them too (see integrity.ts
 * VERIFIED_NAMESPACES). A backend cutover therefore restores the precious,
 * single-copy data; derived/recorder data re-accrues from use. (Full transparent
 * copy of every generic store is a possible future enhancement, but it is NOT a
 * silent gap — it is this documented boundary.)
 *
 * Throws if a namespace the target claims to support fails mid-write — the
 * caller is expected to roll the active driver back.
 */
export async function migrateData(
  from: StorageDriver,
  to: StorageDriver,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    settings: 0,
    reviewItems: 0,
    questionResults: 0,
    masterySnapshots: 0,
    chunks: 0,
    chunksEmbeddingsDropped: 0,
    skipped: [],
  };

  // settings — always present on both drivers (keyed upsert, idempotent).
  const settingsRows = await from.settings.toArray();
  for (const row of settingsRows) {
    await to.settings.put(row);
  }
  report.settings = settingsRows.length;

  // reviewItems (keyed upsert, idempotent)
  if (from.reviewItems && to.reviewItems) {
    const items = await from.reviewItems.toArray();
    if (items.length) await to.reviewItems.bulkPut(items);
    report.reviewItems = items.length;
  } else {
    report.skipped.push('reviewItems');
  }

  // questionResults (append-only — overwrite clears the target log first so a
  // forced re-run is idempotent rather than duplicating; DATA-2).
  if (from.questionResults && to.questionResults) {
    if (options.overwrite) await to.questionResults.clear();
    const results = await from.questionResults.toArray();
    if (results.length) await to.questionResults.bulkAdd(results);
    report.questionResults = results.length;
  } else {
    report.skipped.push('questionResults');
  }

  // masterySnapshots (keyed upsert, idempotent)
  if (from.masterySnapshots && to.masterySnapshots) {
    const snaps = await from.masterySnapshots.toArray();
    for (const snap of snaps) {
      await to.masterySnapshots.put(snap);
    }
    report.masterySnapshots = snaps.length;
  } else {
    report.skipped.push('masterySnapshots');
  }

  // chunks (DATA-7) — copy the vector corpus when the source can enumerate it,
  // dimension-guarded so the target's MTREE rebuilds from existing vectors
  // instead of forcing hours of re-embedding. `bulkUpsert` is keyed → idempotent
  // (re-runs overwrite by id), so no clear is needed even under `overwrite`.
  if (options.migrateChunks ?? true) {
    if (from.chunks?.exportAll && to.chunks?.bulkUpsert) {
      const sourceChunks = await from.chunks.exportAll();
      const guard = guardChunkEmbeddings(sourceChunks, options.embeddingDimension);
      if (guard.chunks.length) await to.chunks.bulkUpsert(guard.chunks);
      report.chunks = guard.chunks.length;
      report.chunksEmbeddingsDropped = guard.dropped;
      if (guard.dropped > 0) {
        report.skipped.push(
          `${guard.dropped} chunk embedding(s) dropped (dimension != ${guard.dimension})`,
        );
      }
    } else {
      // Source can't enumerate its corpus — re-ingest to rebuild (historical).
      report.skipped.push('chunks (re-ingest to rebuild the vector index)');
    }
  } else {
    report.skipped.push('chunks (migrateChunks: false)');
  }

  return report;
}

// ---------------------------------------------------------------------------
// DATA-2 — cutover dry-run + manifest. A PURE READ preview of what a cutover
// would copy and whether running it now is loss-safe, so the System Health UI
// can show the user the plan (and refuse a footgun) BEFORE any mutation.
// ---------------------------------------------------------------------------

/** One namespace's source-vs-target row counts in a cutover preview. */
export interface NamespaceManifestRow {
  namespace: string;
  sourceCount: number;
  targetCount: number;
  /** True when the target already holds rows here — a duplication/clobber risk. */
  targetNonEmpty: boolean;
}

/** The chunk/embedding portion of a cutover preview. */
export interface ChunkManifest {
  sourceCount: number;
  /** Source chunks carrying an embedding. */
  embedded: number;
  /** Corpus embedding dimension (modal length), or null when none/unavailable. */
  dimension: number | null;
  targetCount: number;
  /** False when the source driver can't enumerate chunks (no `exportAll`). */
  migratable: boolean;
}

/** Result of {@link buildCutoverManifest} — the cutover dry-run. */
export interface CutoverManifest {
  from: string;
  to: string;
  namespaces: NamespaceManifestRow[];
  chunks: ChunkManifest;
  /** True when running the cutover now is loss-safe (every target table empty). */
  safe: boolean;
  /** Human-readable reasons it is NOT safe (empty when safe). */
  blockers: string[];
}

async function namespaceCount(
  driver: StorageDriver,
  namespace: 'settings' | 'reviewItems' | 'questionResults' | 'masterySnapshots',
): Promise<number> {
  switch (namespace) {
    case 'settings':
      return (await driver.settings.toArray()).length;
    case 'reviewItems':
      return driver.reviewItems ? (await driver.reviewItems.toArray()).length : 0;
    case 'questionResults':
      return driver.questionResults ? (await driver.questionResults.toArray()).length : 0;
    case 'masterySnapshots':
      return driver.masterySnapshots ? (await driver.masterySnapshots.toArray()).length : 0;
    default:
      return 0;
  }
}

/**
 * Build a loss-safety preview of cutting `from` over to `to`, without mutating
 * either driver (DATA-2 dry-run). The cutover is `safe` only when EVERY target
 * table is empty — migrating into a non-empty target risks duplicating the
 * append-only attempt log or clobbering/mixing target-only rows. Each non-empty
 * target table is surfaced as a `blocker` so the UI can warn (and require an
 * explicit force) before running.
 */
export async function buildCutoverManifest(
  from: StorageDriver,
  to: StorageDriver,
): Promise<CutoverManifest> {
  const NS = ['settings', 'reviewItems', 'questionResults', 'masterySnapshots'] as const;
  const namespaces: NamespaceManifestRow[] = [];
  const blockers: string[] = [];

  for (const namespace of NS) {
    const [sourceCount, targetCount] = await Promise.all([
      namespaceCount(from, namespace),
      namespaceCount(to, namespace),
    ]);
    const targetNonEmpty = targetCount > 0;
    namespaces.push({ namespace, sourceCount, targetCount, targetNonEmpty });
    if (targetNonEmpty) {
      blockers.push(`target '${namespace}' already holds ${targetCount} row(s)`);
    }
  }

  // chunks — count via exportAll when available (read-only).
  let sourceChunks: SourceChunkInput[] = [];
  let migratable = false;
  if (from.chunks?.exportAll) {
    migratable = true;
    sourceChunks = await from.chunks.exportAll();
  }
  let targetChunkCount = 0;
  if (to.chunks?.exportAll) {
    targetChunkCount = (await to.chunks.exportAll()).length;
  }
  const guard = guardChunkEmbeddings(sourceChunks);
  if (targetChunkCount > 0) {
    blockers.push(`target 'chunks' already holds ${targetChunkCount} row(s)`);
  }

  const chunks: ChunkManifest = {
    sourceCount: sourceChunks.length,
    embedded: guard.embedded,
    dimension: guard.dimension,
    targetCount: targetChunkCount,
    migratable,
  };

  return {
    from: from.name,
    to: to.name,
    namespaces,
    chunks,
    safe: blockers.length === 0,
    blockers,
  };
}
