// AUDIT-2 — wire the DATA-5 unified {host, lsat} backup/restore into a usable
// action. The envelope machinery (src/lib/unifiedExportEnvelope.ts) and the
// backend routes (POST /api/export/backup · /api/export/import) were both built
// but nothing invoked them — the host's existing backup buttons only round-trip
// the Dexie store. This composes the two halves into ONE artifact:
//
//   EXPORT  — POST the host's Dexie VaultExport as `host_data`; the backend folds
//             in the LSAT bank export (firewalled: no official content) and returns
//             the full checksummed envelope, which we download.
//   RESTORE — validate the envelope (schema + checksum + official-content firewall)
//             host-side, POST it to the backend to restore the LSAT half, THEN
//             re-apply `hostData` to Dexie here (the backend deliberately never
//             writes the host store — it only reports host_data_present).
//
// Unlike the always-degrading background seam hooks, these are USER actions: a
// down sidecar throws a clear `UnifiedBackupError` the UI surfaces, rather than a
// silent no-op, because the LSAT half genuinely needs the backend.

import { exportVaultData, importVaultData } from './progressStore';
import {
  downloadEnvelope,
  validateEnvelope,
  type UnifiedExportEnvelope,
} from './unifiedExportEnvelope';

const LSAT_API_BASE = 'http://127.0.0.1:8100';
const EXPORT_BACKUP_PATH = '/api/export/backup';
const EXPORT_IMPORT_PATH = '/api/export/import';

/** Raised for any user-surfaced unified-backup failure (down sidecar, bad file,
 *  invalid envelope). Carries a human-readable message for a toast. */
export class UnifiedBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedBackupError';
  }
}

const SIDECAR_DOWN_HINT =
  'The LSAT backend (127.0.0.1:8100) must be running to build or restore a unified backup. ' +
  'Your host-only (Dexie) backup still works offline.';

export interface UnifiedRestoreResult {
  exportId: string;
  /** Per-store counts the backend restored for the LSAT half. */
  counts: Record<string, number>;
  /** True when the envelope carried a host half that was re-applied to Dexie. */
  hostApplied: boolean;
}

/**
 * Build and download the unified {host, lsat} backup. Reads the host Dexie store,
 * asks the backend to fold in the LSAT bank + compute the checksum, and downloads
 * the resulting envelope. Throws {@link UnifiedBackupError} if the backend is
 * unreachable.
 */
export async function exportUnifiedBackup(
  opts: { includeHistory?: boolean; timeoutMs?: number } = {},
): Promise<UnifiedExportEnvelope> {
  const hostData = (await exportVaultData()) as unknown as Record<string, unknown>;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(`${LSAT_API_BASE}${EXPORT_BACKUP_PATH}`, {
      signal: controller.signal,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ host_data: hostData, include_history: opts.includeHistory ?? false }),
    });
    if (!res.ok) {
      throw new UnifiedBackupError(`The LSAT backend responded ${res.status} building the backup.`);
    }
    const envelope = (await res.json()) as UnifiedExportEnvelope;
    downloadEnvelope(envelope);
    return envelope;
  } catch (err) {
    if (err instanceof UnifiedBackupError) throw err;
    throw new UnifiedBackupError(SIDECAR_DOWN_HINT);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Restore a unified backup from raw file text. Validates the envelope (schema +
 * checksum + official-content firewall) BEFORE any write, restores the LSAT half
 * via the backend, then re-applies the host half to Dexie (the backend never
 * writes the host store). `mode` defaults to 'merge' (non-destructive). Throws
 * {@link UnifiedBackupError} on a bad file, invalid envelope, or down backend.
 */
export async function importUnifiedBackup(
  fileText: string,
  opts: { mode?: 'merge' | 'replace'; timeoutMs?: number } = {},
): Promise<UnifiedRestoreResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new UnifiedBackupError('The selected file is not valid JSON.');
  }

  const validation = validateEnvelope(parsed);
  if (!validation.ok) {
    throw new UnifiedBackupError(`This is not a valid unified backup: ${validation.errors.join('; ')}`);
  }
  const envelope = parsed as UnifiedExportEnvelope;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  let exportId = envelope.exportId;
  let counts: Record<string, number> = {};
  try {
    const res = await fetch(`${LSAT_API_BASE}${EXPORT_IMPORT_PATH}`, {
      signal: controller.signal,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ envelope }),
    });
    if (!res.ok) {
      throw new UnifiedBackupError(`The LSAT backend responded ${res.status} restoring the backup.`);
    }
    const data = (await res.json()) as { export_id?: string; counts?: Record<string, number> };
    if (typeof data.export_id === 'string') exportId = data.export_id;
    if (data.counts && typeof data.counts === 'object') counts = data.counts;
  } catch (err) {
    if (err instanceof UnifiedBackupError) throw err;
    throw new UnifiedBackupError(SIDECAR_DOWN_HINT);
  } finally {
    clearTimeout(timer);
  }

  // The backend restored only the LSAT bank; apply the host half to Dexie here.
  let hostApplied = false;
  if (envelope.hostData && typeof envelope.hostData === 'object') {
    await importVaultData(envelope.hostData, opts.mode ?? 'merge');
    hostApplied = true;
  }

  return { exportId, counts, hostApplied };
}
