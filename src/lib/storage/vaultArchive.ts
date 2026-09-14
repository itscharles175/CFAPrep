// GAP-PORT-1 — verified, self-describing vault archive (Wave 3a, data-safety).
//
// A backup is only trustworthy if a restore is PROVEN to reproduce it. The host
// already round-trips its whole Dexie vault through `exportVaultData` /
// `importVaultData` (src/lib/progressStore.ts), and the unified {host,lsat}
// envelope (src/lib/unifiedExportEnvelope.ts, DATA-5) already wraps both planes
// with a whole-artifact checksum. Neither, on its own, lets a restore drill
// answer the only question that matters offline: "did every byte of every store
// survive export -> wipe -> import?".
//
// This module adds exactly that, WITHOUT duplicating the export/import or the
// envelope: it wraps an EXISTING host `VaultExport` (and, optionally, the LSAT
// bank payload from the DATA-5 envelope) into ONE self-describing artifact whose
// manifest carries a PER-STORE SHA-256 over canonical JSON plus the schema
// versions in force at build time. `verifyVaultArchive` recomputes every digest
// and re-checks the versions, so truncation, corruption, or version skew are
// caught BEFORE a restore is trusted — and the drill (scripts/vault-archive-drill.mjs)
// asserts the rebuilt vault re-derives byte-identical per-store digests.
//
// Determinism: the per-store digest reuses the SAME canonical-JSON + synchronous
// SHA-256 the DATA-3 / DATA-5 path uses (`canonicalJson` + `sha256Hex` from
// unifiedExportEnvelope.ts), so a host-built archive and a backend that adopts
// the same primitives agree byte-for-byte. Everything here is pure + offline:
// no Dexie, no network, no sidecar, no DOM. Callers (the export action, the CI
// drill) own I/O and timestamps.

import type { VaultExport } from '../progressStore';
import { VAULT_SCHEMA_VERSION, VAULT_SCHEMA_HASH, VAULT_CONTENT_VERSION } from '../progressStore';
import { canonicalJson, sha256Hex } from '../unifiedExportEnvelope';

/**
 * The archive-format version. Bumped only when the ARCHIVE shape (manifest +
 * payload framing) changes — distinct from the host `VAULT_SCHEMA_VERSION` and
 * the DATA-5 `UNIFIED_EXPORT_SCHEMA_VERSION`. `verifyVaultArchive` refuses an
 * archive whose `archiveVersion` is newer than this build understands.
 */
export const VAULT_ARCHIVE_VERSION = 1;

/** A single store's identity inside the archive manifest. */
export interface VaultArchiveStoreEntry {
  /** Store name, e.g. `host:questionResults` or `lsat:bank`. */
  name: string;
  /** Row count at build time (top-level array length for the store). */
  count: number;
  /** Lowercase-hex SHA-256 over the canonical JSON of the store's rows. */
  sha256: string;
}

/** Schema versions pinned at build time so a restore can detect version skew. */
export interface VaultArchiveSchemaVersions {
  /** Host Dexie `VAULT_SCHEMA_VERSION` at build time. */
  host: number;
  /** Host `VAULT_SCHEMA_HASH` — guards a same-number-but-different-shape skew. */
  hostSchemaHash: string;
  /** Host `VAULT_CONTENT_VERSION` — the curriculum pack the vault was built on. */
  hostContentVersion: string;
  /**
   * LSAT bank `schema_version` when an LSAT payload is included (the value the
   * DATA-5 envelope carries under `data.schema_version`). Omitted for a
   * host-only archive.
   */
  lsat?: number;
}

/** The self-describing manifest. Carries no timestamp — the CALLER stamps it. */
export interface VaultArchiveManifest {
  archiveVersion: number;
  /** App build that produced the archive (caller-supplied; "" when unknown). */
  appVersion: string;
  schemaVersions: VaultArchiveSchemaVersions;
  /** Per-store identity (count + canonical-JSON digest), stable-sorted by name. */
  stores: VaultArchiveStoreEntry[];
}

/** The verified, self-describing archive. */
export interface VaultArchive {
  manifest: VaultArchiveManifest;
  /**
   * The wrapped data. `host` is the verbatim `VaultExport` (its own internal
   * checksum is left intact). `lsat` is the optional LSAT bank payload (the
   * DATA-5 envelope's `data`), referenced read-only — NOT fetched here.
   */
  payload: {
    host: VaultExport;
    lsat?: Record<string, unknown>;
  };
}

export interface BuildVaultArchiveOptions {
  /** App/build version string stamped into the manifest. Defaults to "". */
  appVersion?: string;
  /**
   * Optional LSAT bank payload to fold in (the DATA-5 envelope's `data`). When
   * present, its top-level array stores are digested alongside the host stores
   * and `schemaVersions.lsat` is recorded. Pass the bank export verbatim — this
   * module never contacts the sidecar.
   */
  lsatPayload?: Record<string, unknown> | null;
}

export interface VaultArchiveMismatch {
  /**
   * What failed: a store digest, a store row-count, a missing/extra store, the
   * archive version, or a schema-version field.
   */
  kind: 'archive-version' | 'schema-version' | 'store-missing' | 'store-extra' | 'count' | 'checksum';
  /** Store name for store-level mismatches; the field name for version ones. */
  name: string;
  expected: string | number;
  actual: string | number;
}

export interface VaultArchiveVerification {
  ok: boolean;
  mismatches: VaultArchiveMismatch[];
}

// --- store extraction --------------------------------------------------------

const HOST_STORE_PREFIX = 'host:';
const HOST_SOURCE_STORE_PREFIX = 'host-source:';
const HOST_DERIVED_STORE_PREFIX = 'host-derived:';
const LSAT_STORE_PREFIX = 'lsat:';

/**
 * The canonical, name->rows view the archive digests. Every top-level entry of
 * the host `VaultExport.stores` is included (each is an array of rows). Explicit
 * full-vault exports also include every array store under `sourceVault` and
 * `derivedStores`; the manifest exposes only store identity, row count, and a
 * digest, never source text or study history. Finally —
 * when present — each top-level ARRAY of the LSAT bank payload. Non-array LSAT
 * fields (scalars like `schema_version`, nested objects) are intentionally NOT
 * per-store digested: the LSAT half's own whole-artifact integrity is the
 * DATA-5 envelope's job; here we capture the bulk row collections that dominate
 * a backup so a restore drill can prove they survived. The result is sorted by
 * name so the manifest is stable across builds.
 */
function collectStores(
  host: VaultExport,
  lsat?: Record<string, unknown> | null,
): Array<{ name: string; rows: unknown[] }> {
  const out: Array<{ name: string; rows: unknown[] }> = [];

  const hostStores = (host.stores ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(hostStores)) {
    const value = hostStores[key];
    if (Array.isArray(value)) {
      out.push({ name: `${HOST_STORE_PREFIX}${key}`, rows: value });
    }
  }

  const sourceStores = (host.sourceVault ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(sourceStores)) {
    const value = sourceStores[key];
    if (Array.isArray(value)) {
      out.push({ name: `${HOST_SOURCE_STORE_PREFIX}${key}`, rows: value });
    }
  }

  const derivedStores = (host.derivedStores ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(derivedStores)) {
    const value = derivedStores[key];
    if (Array.isArray(value)) {
      out.push({ name: `${HOST_DERIVED_STORE_PREFIX}${key}`, rows: value });
    }
  }

  if (lsat && typeof lsat === 'object') {
    for (const key of Object.keys(lsat)) {
      const value = lsat[key];
      if (Array.isArray(value)) {
        out.push({ name: `${LSAT_STORE_PREFIX}${key}`, rows: value });
      }
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Per-store digest = SHA-256 of the canonical JSON of the store's row array. */
function digestStore(rows: unknown[]): string {
  return sha256Hex(canonicalJson(rows));
}

function lsatSchemaVersion(lsat?: Record<string, unknown> | null): number | undefined {
  if (!lsat || typeof lsat !== 'object') return undefined;
  const v = (lsat as Record<string, unknown>).schema_version;
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

// --- build -------------------------------------------------------------------

/**
 * Wrap an EXISTING host `VaultExport` (and an optional LSAT bank payload) into a
 * self-describing, per-store-checksummed archive.
 *
 * The caller supplies the host export (from `exportVaultData()`) and stamps the
 * archive timestamp itself when persisting — the manifest deliberately carries
 * no `createdAt` so the artifact is a pure function of its data and stays
 * byte-stable for the verify/drill round-trip.
 *
 * @param host  a verbatim host `VaultExport` (its internal checksum is preserved)
 * @param options.appVersion   app/build string stamped into the manifest
 * @param options.lsatPayload  optional LSAT bank export (DATA-5 envelope `data`)
 */
export function buildVaultArchive(
  host: VaultExport,
  options: BuildVaultArchiveOptions = {},
): VaultArchive {
  const lsat = options.lsatPayload ?? undefined;
  const stores = collectStores(host, lsat);

  const schemaVersions: VaultArchiveSchemaVersions = {
    host: typeof host.schemaVersion === 'number' ? host.schemaVersion : VAULT_SCHEMA_VERSION,
    hostSchemaHash: typeof host.schemaHash === 'string' ? host.schemaHash : VAULT_SCHEMA_HASH,
    hostContentVersion:
      typeof host.contentVersion === 'string' ? host.contentVersion : VAULT_CONTENT_VERSION,
  };
  const lsatVersion = lsatSchemaVersion(lsat);
  if (lsatVersion !== undefined) schemaVersions.lsat = lsatVersion;

  const manifest: VaultArchiveManifest = {
    archiveVersion: VAULT_ARCHIVE_VERSION,
    appVersion: options.appVersion ?? '',
    schemaVersions,
    stores: stores.map((s) => ({
      name: s.name,
      count: s.rows.length,
      sha256: digestStore(s.rows),
    })),
  };

  return {
    manifest,
    payload: lsat ? { host, lsat } : { host },
  };
}

// --- verify ------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recompute every per-store checksum + the schema versions and report any
 * divergence. Side-effect-free; never throws on a malformed archive — a bad
 * shape is reported as mismatches so a drill or UI can surface it uniformly.
 *
 * Detects: truncation/corruption (a store digest no longer matches its rows),
 * row drops (count drift), a manifest that omits a payload store or claims one
 * the payload lacks, an `archiveVersion` newer than this build, and schema-
 * version skew (host number/hash/content-version, LSAT number).
 */
export function verifyVaultArchive(archive: unknown): VaultArchiveVerification {
  const mismatches: VaultArchiveMismatch[] = [];

  if (!isObject(archive) || !isObject(archive.manifest) || !isObject(archive.payload)) {
    return {
      ok: false,
      mismatches: [{ kind: 'archive-version', name: 'archive', expected: 'object', actual: typeof archive }],
    };
  }

  const manifest = archive.manifest as Partial<VaultArchiveManifest> & Record<string, unknown>;
  const payload = archive.payload as { host?: unknown; lsat?: unknown };

  // Archive-format version: refuse a forward-incompatible artifact.
  const archiveVersion = manifest.archiveVersion;
  if (typeof archiveVersion !== 'number' || archiveVersion > VAULT_ARCHIVE_VERSION) {
    mismatches.push({
      kind: 'archive-version',
      name: 'archiveVersion',
      expected: VAULT_ARCHIVE_VERSION,
      actual: typeof archiveVersion === 'number' ? archiveVersion : String(archiveVersion),
    });
    // A version we don't understand can't be checked further — bail with what we have.
    return { ok: false, mismatches };
  }

  const host = payload.host;
  if (!isObject(host)) {
    return {
      ok: false,
      mismatches: [...mismatches, { kind: 'store-missing', name: 'payload.host', expected: 'object', actual: typeof host }],
    };
  }
  const lsat = isObject(payload.lsat) ? payload.lsat : undefined;

  // Recompute the live store view from the payload.
  const liveStores = collectStores(host as unknown as VaultExport, lsat);
  const liveByName = new Map(liveStores.map((s) => [s.name, s]));

  const manifestStores = Array.isArray(manifest.stores) ? manifest.stores : [];
  const manifestNames = new Set<string>();

  for (const entry of manifestStores) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue;
    manifestNames.add(entry.name);
    const live = liveByName.get(entry.name);
    if (!live) {
      mismatches.push({ kind: 'store-missing', name: entry.name, expected: 'present', actual: 'absent' });
      continue;
    }
    if (live.rows.length !== entry.count) {
      mismatches.push({
        kind: 'count',
        name: entry.name,
        expected: typeof entry.count === 'number' ? entry.count : String(entry.count),
        actual: live.rows.length,
      });
    }
    const actualDigest = digestStore(live.rows);
    if (actualDigest !== entry.sha256) {
      mismatches.push({
        kind: 'checksum',
        name: entry.name,
        expected: typeof entry.sha256 === 'string' ? entry.sha256 : String(entry.sha256),
        actual: actualDigest,
      });
    }
  }

  // A payload store the manifest never described is an integrity gap too —
  // something was added after the manifest was sealed.
  for (const live of liveStores) {
    if (!manifestNames.has(live.name)) {
      mismatches.push({ kind: 'store-extra', name: live.name, expected: 'in-manifest', actual: 'payload-only' });
    }
  }

  // Schema-version skew: compare the manifest's recorded versions against the
  // versions the wrapped payload actually carries.
  const sv: Partial<VaultArchiveSchemaVersions> = isObject(manifest.schemaVersions)
    ? (manifest.schemaVersions as Partial<VaultArchiveSchemaVersions>)
    : {};
  const hostExport = host as unknown as VaultExport;
  checkVersion(mismatches, 'schemaVersions.host', sv.host, hostExport.schemaVersion);
  checkVersion(mismatches, 'schemaVersions.hostSchemaHash', sv.hostSchemaHash, hostExport.schemaHash);
  checkVersion(
    mismatches,
    'schemaVersions.hostContentVersion',
    sv.hostContentVersion,
    hostExport.contentVersion,
  );
  if (lsat) {
    checkVersion(mismatches, 'schemaVersions.lsat', sv.lsat, lsatSchemaVersion(lsat));
  }

  return { ok: mismatches.length === 0, mismatches };
}

function checkVersion(
  mismatches: VaultArchiveMismatch[],
  name: string,
  expected: unknown,
  actual: unknown,
): void {
  // Only flag when the payload actually carries the field; a payload that simply
  // doesn't expose a version isn't skew (the manifest is the source of truth).
  if (actual === undefined) return;
  if (expected !== actual) {
    mismatches.push({
      kind: 'schema-version',
      name,
      expected: expected === undefined ? '(unset)' : (expected as string | number),
      actual: actual as string | number,
    });
  }
}
