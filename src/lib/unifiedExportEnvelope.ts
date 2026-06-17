// DATA-5 — the unified {host, lsat} export/backup envelope (host side).
//
// One artifact wraps BOTH planes so "back up StudyVault" is a single atomic
// action: the LSAT bank export (the backend's `bank_export` JSON, served by
// `POST /api/export/backup`) under `data`, and the host's Dexie `VaultExport`
// (see src/lib/progressStore.ts) under `hostData`. A shared `exportId` /
// `exportedAt` / `checksum` identify the whole vault snapshot.
//
// The envelope shape + checksum algorithm mirror the backend
// (`services/lsat-backend/app/export_backup.py`): `checksum` is the sha256 of the
// CANONICAL JSON of the envelope WITHOUT its own `checksum` field (sorted keys,
// compact separators), prefixed `sha256:`. Computing it the same way on both
// sides means a backend-built envelope verifies here and vice-versa.
//
// FIREWALL: the copyrighted `official` LSAT content never enters an export
// (enforced by `bank_export.export_bank(include_official=False)` on the backend);
// `validateEnvelope` ALSO rejects any envelope whose `data` smuggles official
// content, so a hand-edited artifact fails before it can be imported.

// The unified-envelope schema version. Bumped when the ENVELOPE shape changes —
// distinct from the LSAT `data.schema_version` and the host
// `VAULT_SCHEMA_VERSION`. Must equal the backend's `export_backup.SCHEMA_VERSION`.
export const UNIFIED_EXPORT_SCHEMA_VERSION = 1;
export const UNIFIED_EXPORT_FORMAT = "unified-json";

const OFFICIAL_SOURCE = "official";

export type UnifiedExportEnvelope = {
  exportId: string;
  exportedAt: string;
  schemaVersion: number;
  /** The host's Dexie VAULT_SCHEMA_VERSION when the host half is included. */
  hostSchemaVersion?: number;
  format: string;
  /** True when produced by the source machine's build; false after an import. */
  sourceHost: boolean;
  rowCounts: Record<string, number>;
  checksum: string;
  /** The LSAT bank export (backend `bank_export` JSON). */
  data: Record<string, unknown>;
  /** The host's verbatim VaultExport (optional — omit for an LSAT-only backup). */
  hostData?: Record<string, unknown>;
};

export type EnvelopeValidation = {
  ok: boolean;
  errors: string[];
};

export type BuildEnvelopeOptions = {
  exportId?: string;
  exportedAt?: string;
  sourceHost?: boolean;
  rowCounts?: Record<string, number>;
};

// --- canonical JSON + sha256 (mirrors the backend) -------------------------
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON used for the checksum: object keys sorted, compact
 * separators, `undefined` dropped. Equivalent to Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))` for JSON-safe data.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const SHA256_INITIAL_HASH = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Synchronous sha256 hex of a string (matches progressStore.ts's impl). */
export function sha256Hex(source: string): string {
  const bytes = Array.from(new TextEncoder().encode(source));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highBits >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowBits >>> shift) & 0xff);

  const hash = [...SHA256_INITIAL_HASH];
  const words = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] =
        ((bytes[position] << 24) |
          (bytes[position + 1] << 16) |
          (bytes[position + 2] << 8) |
          bytes[position + 3]) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const sigma0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const sigma1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + ch + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

/** sha256 of the canonical JSON of `envelope` WITHOUT its `checksum` field. */
export function computeEnvelopeChecksum(
  envelope: Omit<UnifiedExportEnvelope, "checksum"> & { checksum?: string },
): string {
  const { checksum: _checksum, ...payload } = envelope;
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

function exportIdFor(exportedAt: string): string {
  const digits = exportedAt.replace(/[^0-9]/g, "").slice(0, 14);
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 8) ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `sv-${digits}-${random}`;
}

function bankRowCounts(bank: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  const preptests = Array.isArray(bank.preptests) ? bank.preptests : [];
  counts.preptests = preptests.length;
  let questions = 0;
  for (const pt of preptests) {
    if (!isObject(pt)) continue;
    const sections = Array.isArray(pt.sections) ? pt.sections : [];
    for (const sec of sections) {
      if (!isObject(sec)) continue;
      const qs = Array.isArray(sec.questions) ? sec.questions : [];
      questions += qs.length;
    }
  }
  const unsectioned = Array.isArray(bank.unsectioned_questions)
    ? bank.unsectioned_questions
    : [];
  questions += unsectioned.length;
  counts.questions = questions;
  for (const key of [
    "unsectioned_questions",
    "study_plans",
    "settings",
    "playlists",
    "annotations",
    "embeddings",
    "study_sessions",
    "attempts",
    "error_log",
    "srs_cards",
    "reflections",
    "explanation_feedback",
  ]) {
    const val = bank[key];
    if (Array.isArray(val)) counts[key] = val.length;
  }
  return counts;
}

function bankCarriesOfficial(bank: Record<string, unknown>): boolean {
  const isOfficialQuestion = (q: unknown): boolean =>
    isObject(q) && String(q.source ?? "") === OFFICIAL_SOURCE;
  const preptests = Array.isArray(bank.preptests) ? bank.preptests : [];
  for (const pt of preptests) {
    if (!isObject(pt)) continue;
    if (pt.is_official === true) return true;
    const sections = Array.isArray(pt.sections) ? pt.sections : [];
    for (const sec of sections) {
      if (!isObject(sec)) continue;
      const qs = Array.isArray(sec.questions) ? sec.questions : [];
      if (qs.some(isOfficialQuestion)) return true;
    }
  }
  const unsectioned = Array.isArray(bank.unsectioned_questions)
    ? bank.unsectioned_questions
    : [];
  return unsectioned.some(isOfficialQuestion);
}

/**
 * Build a unified envelope from the LSAT bank export (`data`) and an optional
 * host `VaultExport` (`hostData`). The checksum is computed over the canonical
 * payload, matching the backend so either side's artifact verifies on the other.
 */
export function buildUnifiedEnvelope(
  lsatPayload: Record<string, unknown>,
  hostData?: Record<string, unknown> | null,
  options?: BuildEnvelopeOptions,
): UnifiedExportEnvelope {
  const exportedAt = options?.exportedAt ?? new Date().toISOString();
  const exportId = options?.exportId ?? exportIdFor(exportedAt);

  const rowCounts = options?.rowCounts ?? bankRowCounts(lsatPayload);
  if (hostData) rowCounts.host_present = 1;

  let hostSchemaVersion: number | undefined;
  if (hostData && typeof hostData.schemaVersion === "number") {
    hostSchemaVersion = hostData.schemaVersion;
  }

  const base: Omit<UnifiedExportEnvelope, "checksum"> = {
    exportId,
    exportedAt,
    schemaVersion: UNIFIED_EXPORT_SCHEMA_VERSION,
    format: UNIFIED_EXPORT_FORMAT,
    sourceHost: options?.sourceHost ?? true,
    rowCounts,
    data: lsatPayload,
    ...(hostSchemaVersion !== undefined ? { hostSchemaVersion } : {}),
    ...(hostData ? { hostData } : {}),
  };
  return { ...base, checksum: computeEnvelopeChecksum(base) };
}

/**
 * Verify an envelope's schema + checksum + the official-content firewall BEFORE
 * an import. Side-effect-free; returns `{ ok, errors }`.
 */
export function validateEnvelope(envelope: unknown): EnvelopeValidation {
  const errors: string[] = [];
  if (!isObject(envelope)) {
    return { ok: false, errors: ["envelope must be a JSON object"] };
  }

  for (const key of [
    "exportId",
    "exportedAt",
    "schemaVersion",
    "format",
    "checksum",
    "data",
  ]) {
    if (!(key in envelope)) errors.push(`missing required field: ${key}`);
  }

  const schema = envelope.schemaVersion;
  if (schema !== undefined) {
    if (typeof schema !== "number" || !Number.isInteger(schema)) {
      errors.push(`schemaVersion must be an integer (got ${String(schema)})`);
    } else if (schema > UNIFIED_EXPORT_SCHEMA_VERSION) {
      errors.push(
        `envelope schemaVersion=${schema} is newer than this build ` +
          `(supports up to ${UNIFIED_EXPORT_SCHEMA_VERSION}); upgrade StudyVault to import it`,
      );
    }
  }

  if (envelope.format !== undefined && envelope.format !== UNIFIED_EXPORT_FORMAT) {
    errors.push(
      `unsupported format ${String(envelope.format)} (expected ${UNIFIED_EXPORT_FORMAT})`,
    );
  }

  const data = envelope.data;
  if (data !== undefined && !isObject(data)) {
    errors.push("data must be a JSON object (the LSAT bank export)");
  }

  const checksum = envelope.checksum;
  if (typeof checksum === "string" && checksum) {
    const actual = computeEnvelopeChecksum(
      envelope as Omit<UnifiedExportEnvelope, "checksum"> & { checksum?: string },
    );
    if (actual !== checksum) {
      errors.push("checksum does not match envelope payload");
    }
  }

  if (isObject(data) && bankCarriesOfficial(data)) {
    errors.push(
      "envelope carries official (copyrighted) content, which may not be " +
        "imported over the unified export path (provenance firewall)",
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Trigger a browser download of the envelope as a pretty-printed JSON file.
 * No-op outside a DOM (e.g. SSR / tests) so callers don't need to guard.
 */
export function downloadEnvelope(
  envelope: UnifiedExportEnvelope,
  filename?: string,
): void {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    return;
  }
  const name = filename ?? `studyvault-${envelope.exportId}.json`;
  const blob = new Blob([JSON.stringify(envelope, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
