// DATA-5 — migrate legacy per-domain exports into the unified envelope.
//
// Before DATA-5 each plane exported alone:
//   * the LSAT backend's portable bank JSON (`bank_export`): a top-level object
//     with `schema_version` + `preptests` (+ optional user-data arrays), and NO
//     unified-envelope fields; and
//   * the host's Dexie `VaultExport` (src/lib/progressStore.ts): `{ app:
//     'QuantVault', schemaVersion, stores, ... }`.
//
// This module detects those two legacy shapes and lifts them into the unified
// `UnifiedExportEnvelope` so an old artifact can be re-imported through the
// single DATA-5 path. The official-content firewall is re-checked at validate
// time (see `validateEnvelope`), so a legacy bank that somehow held official
// content still cannot cross the unified import boundary.

import {
  buildUnifiedEnvelope,
  type UnifiedExportEnvelope,
} from "./unifiedExportEnvelope";

export type LegacyExportKind = "lsat-bank-v1" | "host-vault" | "unified" | "unknown";

export type DetectedLegacyExport = {
  kind: LegacyExportKind;
  /** The parsed object (already JSON). */
  value: Record<string, unknown>;
  /** True when the object is already a unified envelope (no migration needed). */
  alreadyUnified: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeUnifiedEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.format === "unified-json" &&
    "data" in value &&
    "schemaVersion" in value &&
    "checksum" in value
  );
}

function looksLikeLsatBankV1(value: Record<string, unknown>): boolean {
  // bank_export top-level: `schema_version` (snake) + `preptests` array, and NOT
  // wrapped in a unified envelope (which uses `schemaVersion` + `data`).
  return (
    "preptests" in value &&
    Array.isArray(value.preptests) &&
    !("data" in value) &&
    ("schema_version" in value || "unsectioned_questions" in value)
  );
}

function looksLikeHostVault(value: Record<string, unknown>): boolean {
  // VaultExport: `app === 'QuantVault'` + `stores` object + `schemaVersion`
  // (camel). Not a unified envelope.
  return (
    value.app === "QuantVault" &&
    isObject(value.stores) &&
    "schemaVersion" in value &&
    !("data" in value)
  );
}

/**
 * Classify one parsed JSON object as a known legacy export shape (or unified /
 * unknown). Pure — does not migrate.
 */
export function classifyLegacyExport(value: unknown): DetectedLegacyExport {
  if (!isObject(value)) {
    return { kind: "unknown", value: {}, alreadyUnified: false };
  }
  if (looksLikeUnifiedEnvelope(value)) {
    return { kind: "unified", value, alreadyUnified: true };
  }
  if (looksLikeLsatBankV1(value)) {
    return { kind: "lsat-bank-v1", value, alreadyUnified: false };
  }
  if (looksLikeHostVault(value)) {
    return { kind: "host-vault", value, alreadyUnified: false };
  }
  return { kind: "unknown", value, alreadyUnified: false };
}

/**
 * Detect legacy exports among a list of parsed JSON objects (e.g. files the user
 * dropped in). Returns one classification per input, preserving order.
 */
export function detectLegacyExports(values: unknown[]): DetectedLegacyExport[] {
  return values.map(classifyLegacyExport);
}

/**
 * Migrate ONE legacy export into the unified envelope.
 *
 * - `lsat-bank-v1` becomes the `data` half (no host payload).
 * - `host-vault` becomes the `hostData` half with an EMPTY LSAT `data` (the user
 *   can merge an LSAT bank later); we still produce a valid, checksummed envelope
 *   so the single import path applies.
 * - an `unified` input is returned unchanged (just re-stamped with `newId` when
 *   provided) since no migration is needed.
 *
 * `newId` lets the caller assign a fresh `exportId` (e.g. to avoid colliding with
 * a provenance row already recorded for the legacy artifact). The resulting
 * envelope's `sourceHost` is false — it was reconstructed from a legacy file, not
 * freshly built on the source machine.
 */
export function migrateLegacyToUnified(
  legacy: unknown,
  newId?: string,
): UnifiedExportEnvelope {
  const detected = classifyLegacyExport(legacy);
  const exportedAt = new Date().toISOString();

  if (detected.kind === "unified") {
    // Already unified — re-stamp the id if requested, recompute the checksum so
    // the artifact stays self-consistent, otherwise pass through.
    const env = detected.value as unknown as UnifiedExportEnvelope;
    if (!newId || newId === env.exportId) return env;
    return buildUnifiedEnvelope(env.data ?? {}, env.hostData ?? null, {
      exportId: newId,
      exportedAt: env.exportedAt || exportedAt,
      sourceHost: false,
      rowCounts: env.rowCounts,
    });
  }

  if (detected.kind === "host-vault") {
    return buildUnifiedEnvelope({}, detected.value, {
      exportId: newId,
      exportedAt,
      sourceHost: false,
    });
  }

  if (detected.kind === "lsat-bank-v1") {
    return buildUnifiedEnvelope(detected.value, null, {
      exportId: newId,
      exportedAt,
      sourceHost: false,
    });
  }

  // Unknown shape: best-effort — wrap as the LSAT `data` half so the unified
  // import can still attempt it (and the firewall/validation will reject if it
  // turns out to carry official content or a bad schema).
  return buildUnifiedEnvelope(detected.value, null, {
    exportId: newId,
    exportedAt,
    sourceHost: false,
  });
}
