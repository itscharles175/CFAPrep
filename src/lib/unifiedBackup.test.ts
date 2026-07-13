/*
 * AUDIT-2 — tests for the unified {host, lsat} backup/restore composition. The
 * envelope build/validate/checksum is covered by unifiedExportEnvelope; the
 * backend halves by services/lsat-backend/tests/test_export_backup.py. This guards
 * the host orchestration: host store ↔ backend ↔ Dexie re-apply, and the
 * user-surfaced error contract (down backend throws, never silently no-ops).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exportVaultData = vi.fn();
const importVaultData = vi.fn();
vi.mock('./progressStore', () => ({
  exportVaultData: () => exportVaultData(),
  importVaultData: (payload: unknown, mode?: unknown) => importVaultData(payload, mode),
}));

import { exportUnifiedBackup, importUnifiedBackup, UnifiedBackupError } from './unifiedBackup';
import { encryptVaultBackup } from './encryptedBackup';
import { buildUnifiedEnvelope } from './unifiedExportEnvelope';

beforeEach(() => {
  exportVaultData.mockReset();
  importVaultData.mockReset();
  exportVaultData.mockResolvedValue({ schemaVersion: 11, lessonProgress: [] });
  importVaultData.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('exportUnifiedBackup', () => {
  it('requires a passphrase unless plaintext export is explicitly allowed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(exportUnifiedBackup()).rejects.toThrowError(/encrypted by default/i);
    expect(exportVaultData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the host export and returns the backend-built envelope', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11 });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
    vi.stubGlobal('fetch', fetchMock);

    const out = await exportUnifiedBackup({ allowPlaintext: true });
    expect(out.exportId).toBe(envelope.exportId);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/export/backup');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.host_data).toMatchObject({ schemaVersion: 11 });
    expect(body.allow_plaintext).toBe(true);
  });

  it('POSTs the host export and encrypts the downloaded unified envelope when given a passphrase', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11 });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
    vi.stubGlobal('fetch', fetchMock);

    const out = await exportUnifiedBackup({ passphrase: 'unified passphrase' });
    expect(out.exportId).toBe(envelope.exportId);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.host_data).toMatchObject({ schemaVersion: 11 });
    expect(body.allow_plaintext).toBe(true);
  });

  it('throws a UnifiedBackupError when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(exportUnifiedBackup({ passphrase: 'unified passphrase' })).rejects.toBeInstanceOf(UnifiedBackupError);
  });

  it('throws on a non-2xx backend response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(exportUnifiedBackup({ passphrase: 'unified passphrase' })).rejects.toBeInstanceOf(UnifiedBackupError);
  });
});

describe('importUnifiedBackup', () => {
  it('validates, restores the LSAT half, and re-applies the host half to Dexie', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11, lessonProgress: [{ id: 'a' }] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, export_id: envelope.exportId, counts: { questions: 0 }, host_data_present: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await importUnifiedBackup(JSON.stringify(envelope));
    expect(result.hostApplied).toBe(true);
    expect(result.encrypted).toBe(false);
    expect(result.exportId).toBe(envelope.exportId);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/export/import');
    // The host half is applied to Dexie by us (the backend never writes it).
    expect(importVaultData).toHaveBeenCalledTimes(1);
    expect(importVaultData).toHaveBeenCalledWith(envelope.hostData, 'merge');
  });

  it('rejects a file that is not valid JSON', async () => {
    await expect(importUnifiedBackup('{not json')).rejects.toBeInstanceOf(UnifiedBackupError);
  });

  it('rejects an envelope whose checksum does not match (tamper guard)', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11 });
    const tampered = { ...envelope, data: { preptests: [{ id: 'injected' }] } };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(importUnifiedBackup(JSON.stringify(tampered))).rejects.toBeInstanceOf(UnifiedBackupError);
    expect(fetchMock).not.toHaveBeenCalled(); // never hits the backend with a bad envelope
  });

  it('decrypts encrypted unified backups before validation and restore', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11, lessonProgress: [{ id: 'a' }] });
    const encrypted = await encryptVaultBackup(JSON.stringify(envelope), 'restore passphrase');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, export_id: envelope.exportId, counts: { questions: 0 }, host_data_present: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await importUnifiedBackup(JSON.stringify(encrypted), { passphrase: 'restore passphrase' });
    expect(result.encrypted).toBe(true);
    expect(result.hostApplied).toBe(true);
    expect(importVaultData).toHaveBeenCalledWith(envelope.hostData, 'merge');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/export/import');
  });

  it('does not restore encrypted unified backups without a passphrase', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11 });
    const encrypted = await encryptVaultBackup(JSON.stringify(envelope), 'restore passphrase');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(importUnifiedBackup(JSON.stringify(encrypted))).rejects.toThrowError(/encrypted/i);
    expect(importVaultData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the Dexie re-apply when the envelope carries no host half', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }); // no hostData
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, export_id: envelope.exportId, counts: {}, host_data_present: false }),
    }));
    const result = await importUnifiedBackup(JSON.stringify(envelope));
    expect(result.hostApplied).toBe(false);
    expect(importVaultData).not.toHaveBeenCalled();
  });

  it('applies the host half BEFORE the backend, and reports a precise partial state when the backend then fails', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11, lessonProgress: [{ id: 'a' }] });
    const order: string[] = [];
    importVaultData.mockImplementation(async () => {
      order.push('host');
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      order.push('backend');
      return { ok: false, status: 503 };
    });
    vi.stubGlobal('fetch', fetchMock);
    // Backend fails AFTER the host half is durably applied → the error names the
    // partial state instead of a flat "failed", and host was written first.
    await expect(importUnifiedBackup(JSON.stringify(envelope))).rejects.toThrowError(/host data was restored/i);
    expect(order).toEqual(['host', 'backend']);
    expect(importVaultData).toHaveBeenCalledTimes(1);
  });

  it('fails fast WITHOUT committing the LSAT half when the host half is invalid', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11, lessonProgress: [{ id: 'a' }] });
    importVaultData.mockRejectedValue(new Error('corrupt host vault'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(importUnifiedBackup(JSON.stringify(envelope))).rejects.toThrowError(
      /host half of this backup could not be restored/i,
    );
    expect(fetchMock).not.toHaveBeenCalled(); // LSAT backend never contacted
  });
});
