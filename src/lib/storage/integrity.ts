// DATA-3 — post-migration integrity verification.
//
// A cutover/migration copies every readable namespace from one StorageDriver to
// another (see ./migrate.ts). A copy can silently lose rows (a mid-write throw
// that the caller swallowed), corrupt a field (a lossy serializer), or duplicate
// an append-only row. Because StudyVault is local-first and single-copy — there
// is NO cloud backup — a corrupted cutover is unrecoverable. This module PROVES
// a migration preserved the data so a mismatch can auto-roll-back.
//
// The proof is two cheap, order-independent invariants per namespace:
//   1. row COUNT  — catches lost / duplicated / extra rows.
//   2. canonical-JSON SHA-256 digest — catches a changed field even when the
//      count matches. Keys are sorted recursively and rows are ordered by a
//      stable key, so two drivers holding the SAME logical data produce the SAME
//      hash regardless of how each backend orders its physical storage.
//
// Everything here is pure + OFFLINE. The SHA-256 is the exact same offline
// approach as src/lib/llm/determinism.js (Web Crypto `subtle.digest` with a
// pure-JS fallback); we IMPORT `sha256Hex` from there rather than re-implement
// it, so there is a single hashing source of truth across the host.

import { sha256Hex } from '../llm/determinism.js';
import type { StorageDriver } from './types';

/**
 * The namespaces this verifier gates a cutover on (the rollback-critical set).
 *
 * `chunks` is intentionally EXCLUDED even though DATA-7 now copies them
 * (`migrate.ts`): chunks are RECONSTRUCTIBLE (re-derived from `sourceDocuments`
 * on re-ingestion), so a chunk-copy hiccup is recoverable and must NOT roll back
 * an otherwise-good migration of the irreplaceable user data. The dimension
 * guard also intentionally TRANSFORMS chunks in transit (it strips
 * wrong-dimension embeddings), so a naive source==target chunk digest would
 * false-fail by construction. The manifest still surfaces a non-empty target
 * chunk table as a blocker before a cutover runs (`buildCutoverManifest`), and
 * chunk counts are reported — chunk integrity is observable, just not a rollback
 * gate. The four namespaces here ARE the precious, single-copy data.
 */
export const VERIFIED_NAMESPACES = [
  'settings',
  'reviewItems',
  'questionResults',
  'masterySnapshots',
] as const;

export type VerifiedNamespace = (typeof VERIFIED_NAMESPACES)[number];

/** Per-namespace digest: a row count + a canonical-JSON SHA-256 hex. */
export interface StoreDigest {
  /** Number of rows the driver reported for the namespace. */
  count: number;
  /**
   * Lowercase hex SHA-256 of the canonical serialization of every row.
   * The empty namespace hashes the canonical form of `[]` (a stable constant),
   * so "missing namespace" and "empty namespace" both produce the same,
   * comparable digest rather than throwing.
   */
  hash: string;
}

/** A full vault digest — one {@link StoreDigest} per verified namespace. */
export type VaultDigest = Record<VerifiedNamespace, StoreDigest>;

/** One namespace's source-vs-target comparison. */
export interface NamespaceComparison {
  namespace: VerifiedNamespace;
  sourceCount: number;
  targetCount: number;
  sourceHash: string;
  targetHash: string;
  /** True only when BOTH the count AND the hash match. */
  match: boolean;
}

/** Result of {@link verifyMigration}. `ok` only when every namespace matches. */
export interface VerificationReport {
  ok: boolean;
  perNamespace: NamespaceComparison[];
  /** Namespaces whose count or hash diverged (subset of perNamespace). */
  mismatches: NamespaceComparison[];
}

// ---------------------------------------------------------------------------
// Canonical JSON — recursively key-sorted, so logically-equal objects always
// serialize to the same string regardless of property insertion order.
// ---------------------------------------------------------------------------

/**
 * Deterministically serialize a value to JSON with every object's keys sorted.
 * Arrays keep their order (callers pre-sort row arrays by a stable key first).
 * `undefined` / functions inside objects are dropped exactly as `JSON.stringify`
 * would, so a row carrying `field: undefined` is canonically identical to one
 * omitting the field — matching how IndexedDB and the drivers treat absent
 * optional fields.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = sortValue(obj[key]);
      // Mirror JSON.stringify: skip keys whose value serializes to undefined
      // (undefined / function), so present-but-undefined === absent.
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

/**
 * Stable sort key for a single row. Keyed namespaces have a string `id`; the
 * append-only attempt log (`questionResults`) has none, so we fall back to the
 * row's own canonical JSON — identical logical rows then sort together and the
 * resulting digest is order-independent. The `id` (when present) is prefixed so
 * two rows with the same id but different bodies still sort deterministically.
 */
function rowSortKey(row: unknown): string {
  if (row && typeof row === 'object') {
    const id = (row as { id?: unknown }).id;
    if (typeof id === 'string') return `id:${id}\u0000${canonicalJson(row)}`;
    if (typeof id === 'number') return `id:${id}\u0000${canonicalJson(row)}`;
  }
  return `row:${canonicalJson(row)}`;
}

/**
 * Canonical SHA-256 of a row set: rows are sorted by {@link rowSortKey} then
 * each canonicalized, so physical storage order never affects the digest. Two
 * drivers holding the same logical rows always agree.
 */
async function hashRows(rows: unknown[]): Promise<string> {
  const ordered = [...rows].sort((a, b) => {
    const ka = rowSortKey(a);
    const kb = rowSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return sha256Hex(canonicalJson(ordered));
}

// ---------------------------------------------------------------------------
// Per-namespace readers — tolerate a driver that omits an optional namespace by
// treating it as empty (count 0, the empty-array digest), so a digest is always
// comparable rather than throwing on a partial driver.
// ---------------------------------------------------------------------------

async function readNamespace(driver: StorageDriver, namespace: VerifiedNamespace): Promise<unknown[]> {
  switch (namespace) {
    case 'settings':
      return driver.settings.toArray();
    case 'reviewItems':
      return driver.reviewItems ? driver.reviewItems.toArray() : [];
    case 'questionResults':
      return driver.questionResults ? driver.questionResults.toArray() : [];
    case 'masterySnapshots':
      return driver.masterySnapshots ? driver.masterySnapshots.toArray() : [];
    default:
      return [];
  }
}

/**
 * Strip the backend-assigned auto-id from an append-only `questionResults` row
 * before hashing. The attempt log has NO semantic key — Dexie assigns a numeric
 * `++id` and SurrealDB a random record id — so two FAITHFUL copies across
 * heterogeneous backends carry different `id` values for the same logical rows.
 * Including the id in the digest would make a clean SurrealDB↔Dexie cutover /
 * dual-write commit false-fail. Dropping it (the count still catches
 * duplication / loss) compares the rows by CONTENT, which is what "faithful
 * copy" means for an append-only log.
 */
function stripAutoId(row: unknown): unknown {
  if (row && typeof row === 'object') {
    const { id: _id, ...rest } = row as Record<string, unknown>;
    return rest;
  }
  return row;
}

/** Digest a single namespace of one driver (count + canonical SHA-256). */
export async function computeStoreDigest(
  driver: StorageDriver,
  namespace: VerifiedNamespace,
): Promise<StoreDigest> {
  const rows = await readNamespace(driver, namespace);
  // The count is always over the raw rows; only the append-only log's HASH drops
  // the non-semantic auto-id so heterogeneous backends compare by content.
  const rowsForHash = namespace === 'questionResults' ? rows.map(stripAutoId) : rows;
  return { count: rows.length, hash: await hashRows(rowsForHash) };
}

/** Digest every verified namespace of one driver. */
export async function computeVaultDigest(driver: StorageDriver): Promise<VaultDigest> {
  const out = {} as VaultDigest;
  for (const namespace of VERIFIED_NAMESPACES) {
    out[namespace] = await computeStoreDigest(driver, namespace);
  }
  return out;
}

/**
 * Verify that a migration from `source` into `target` preserved every namespace.
 *
 * Returns `ok: true` only when, for EVERY verified namespace, the source and
 * target agree on both the row count AND the canonical-JSON SHA-256. Any
 * divergence is surfaced in `mismatches` so the caller (cutoverTo) can
 * auto-roll-back rather than strand the user on a corrupted backend.
 *
 * Note on the append-only `questionResults` log: the digest is row-set based and
 * order-independent, so a faithful copy matches even if the target stores rows
 * in a different physical order. A double-run that DUPLICATES rows changes both
 * the count and the hash and is correctly flagged as a mismatch.
 */
export async function verifyMigration(
  source: StorageDriver,
  target: StorageDriver,
): Promise<VerificationReport> {
  const perNamespace: NamespaceComparison[] = [];

  for (const namespace of VERIFIED_NAMESPACES) {
    const [src, tgt] = await Promise.all([
      computeStoreDigest(source, namespace),
      computeStoreDigest(target, namespace),
    ]);
    perNamespace.push({
      namespace,
      sourceCount: src.count,
      targetCount: tgt.count,
      sourceHash: src.hash,
      targetHash: tgt.hash,
      match: src.count === tgt.count && src.hash === tgt.hash,
    });
  }

  const mismatches = perNamespace.filter((n) => !n.match);
  return { ok: mismatches.length === 0, perNamespace, mismatches };
}

/** Human-readable one-line summary of which namespaces diverged. */
export function summarizeMismatches(report: VerificationReport): string {
  if (report.ok) return 'all namespaces match';
  return report.mismatches
    .map(
      (m) =>
        `${m.namespace} (count ${m.sourceCount}→${m.targetCount}, hash ${
          m.sourceHash === m.targetHash ? 'match' : 'differ'
        })`,
    )
    .join(', ');
}
