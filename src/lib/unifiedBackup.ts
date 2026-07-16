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

import type { paths } from '../domains/lsat/lib/api.gen';
import { exportVaultData, importVaultData } from './progressStore';
import { decryptVaultBackup, encryptVaultBackup, isEncryptedBackupBlob } from './encryptedBackup';
import {
  downloadEnvelope,
  validateEnvelope,
  type UnifiedExportEnvelope,
} from './unifiedExportEnvelope';
import { fetchLsatSidecar } from './lsatSidecarClient';

const EXPORT_BACKUP_PATH = '/api/export/backup' satisfies keyof paths;
const EXPORT_IMPORT_PATH = '/api/export/import' satisfies keyof paths;

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
  /** True when the selected artifact was a passphrase-encrypted wrapper. */
  encrypted: boolean;
}

export interface UnifiedBackupExportOptions {
  includeHistory?: boolean;
  timeoutMs?: number;
  /**
   * Primary path: encrypt the unified envelope before it leaves the browser.
   * Plaintext export requires allowPlaintext so call sites make that risk explicit.
   */
  passphrase?: string;
  allowPlaintext?: boolean;
}

export interface UnifiedBackupImportOptions {
  mode?: 'merge' | 'replace';
  timeoutMs?: number;
  /** Required when the selected artifact is a `.qvenc.json` encrypted wrapper. */
  passphrase?: string;
}

function downloadEncryptedUnifiedBackup(
  encryptedBlob: unknown,
  exportId: string,
): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return;
  }
  const file = new Blob([JSON.stringify(encryptedBlob, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `studyvault-${exportId}.qvenc.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function parseJsonOrThrow(fileText: string, message: string): unknown {
  try {
    return JSON.parse(fileText);
  } catch {
    throw new UnifiedBackupError(message);
  }
}

/**
 * Build and download the unified {host, lsat} backup. Reads the host Dexie store,
 * asks the backend to fold in the LSAT bank + compute the checksum, and downloads
 * the resulting envelope. Throws {@link UnifiedBackupError} if the backend is
 * unreachable.
 */
export async function exportUnifiedBackup(
  opts: UnifiedBackupExportOptions = {},
): Promise<UnifiedExportEnvelope> {
  if (!opts.passphrase && !opts.allowPlaintext) {
    throw new UnifiedBackupError(
      'Unified backups are encrypted by default. Enter a passphrase, or use the explicit plaintext export path for a local-only diagnostic copy.',
    );
  }
  const hostData = (await exportVaultData()) as unknown as Record<string, unknown>;
  let res: Response;
  try {
    res = await fetchLsatSidecar(EXPORT_BACKUP_PATH, {
      timeoutMs: opts.timeoutMs ?? 20000,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        host_data: hostData,
        include_history: opts.includeHistory ?? false,
        // The trusted local host encrypts this envelope in-browser so the
        // passphrase never has to cross the sidecar boundary.
        allow_plaintext: opts.allowPlaintext || Boolean(opts.passphrase),
      }),
    });
  } catch (err) {
    if (err instanceof UnifiedBackupError) throw err;
    throw new UnifiedBackupError(SIDECAR_DOWN_HINT);
  }
  if (!res.ok) {
    throw new UnifiedBackupError(`The LSAT backend responded ${res.status} building the backup.`);
  }

  let envelope: UnifiedExportEnvelope;
  try {
    envelope = (await res.json()) as UnifiedExportEnvelope;
  } catch {
    throw new UnifiedBackupError('The LSAT backend returned an invalid backup response.');
  }

  if (opts.passphrase) {
    try {
      const encrypted = await encryptVaultBackup(JSON.stringify(envelope), opts.passphrase);
      downloadEncryptedUnifiedBackup(encrypted, envelope.exportId);
    } catch (err) {
      throw new UnifiedBackupError(
        err instanceof Error ? err.message : 'Could not encrypt the unified backup.',
      );
    }
  } else {
    downloadEnvelope(envelope);
  }
  return envelope;
}

/**
 * Restore a unified backup from raw file text. Validates the envelope (schema +
 * checksum + official-content firewall) BEFORE any write, then applies the HOST
 * half to Dexie FIRST (it self-validates + takes a rollback snapshot) and only
 * then restores the LSAT half via the backend (which never writes the host
 * store) — so a bad host half fails fast before the backend is touched, and a
 * backend failure after the host is applied is reported as a precise partial
 * state. `mode` defaults to 'merge' (non-destructive). Throws
 * {@link UnifiedBackupError} on a bad file, invalid envelope, or down backend.
 */
export async function importUnifiedBackup(
  fileText: string,
  opts: UnifiedBackupImportOptions = {},
): Promise<UnifiedRestoreResult> {
  let parsed = parseJsonOrThrow(fileText, 'The selected file is not valid JSON.');
  let encrypted = false;
  if (isEncryptedBackupBlob(parsed)) {
    if (!opts.passphrase) {
      throw new UnifiedBackupError('This unified backup is encrypted. Enter its passphrase before restoring it.');
    }
    const plaintext = await decryptVaultBackup(parsed, opts.passphrase);
    parsed = parseJsonOrThrow(plaintext, 'The encrypted unified backup decrypted, but its payload is not valid JSON.');
    encrypted = true;
  }

  const validation = validateEnvelope(parsed);
  if (!validation.ok) {
    throw new UnifiedBackupError(`This is not a valid unified backup: ${validation.errors.join('; ')}`);
  }
  const envelope = parsed as UnifiedExportEnvelope;

  // Data-safety: apply the HOST half FIRST. importVaultData validates the payload
  // (and takes a rollback snapshot) before writing, so a malformed/oversized host
  // half fails fast WITHOUT the backend having committed the LSAT half. This
  // replaces the prior LSAT-first order, whose failure mode was: backend 200 →
  // host write throws → LSAT restored, host not, user told a flat "failed". The
  // two halves can't be made truly atomic across a Dexie write + a remote POST, so
  // we order the local (primary, rollback-able) write first and report the precise
  // partial state if the LSAT half then can't be reached.
  let hostApplied = false;
  if (envelope.hostData && typeof envelope.hostData === 'object') {
    try {
      await importVaultData(envelope.hostData, opts.mode ?? 'merge');
      hostApplied = true;
    } catch (err) {
      throw new UnifiedBackupError(
        `The host half of this backup could not be restored (${err instanceof Error ? err.message : 'invalid data'}). ` +
          'Nothing was changed on the LSAT backend.',
      );
    }
  }

  let exportId = envelope.exportId;
  let counts: Record<string, number> = {};
  try {
    const res = await fetchLsatSidecar(EXPORT_IMPORT_PATH, {
      timeoutMs: opts.timeoutMs ?? 30000,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ envelope }),
    });
    if (!res.ok) {
      throw new UnifiedBackupError(
        hostApplied
          ? `Your host data was restored, but the LSAT backend responded ${res.status}, so the LSAT bank was NOT restored. Run the restore again once the backend is healthy.`
          : `The LSAT backend responded ${res.status} restoring the backup.`,
      );
    }
    const data = (await res.json()) as { export_id?: string; counts?: Record<string, number> };
    if (typeof data.export_id === 'string') exportId = data.export_id;
    if (data.counts && typeof data.counts === 'object') counts = data.counts;
  } catch (err) {
    if (err instanceof UnifiedBackupError) throw err;
    throw new UnifiedBackupError(
      hostApplied
        ? 'Your host data was restored, but the LSAT backend was unreachable, so the LSAT bank was NOT restored. Start the backend and run the restore again to finish.'
        : SIDECAR_DOWN_HINT,
    );
  }

  return { exportId, counts, hostApplied, encrypted };
}
