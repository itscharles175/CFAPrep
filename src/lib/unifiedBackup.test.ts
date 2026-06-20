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
  it('POSTs the host export and returns the backend-built envelope', async () => {
    const envelope = buildUnifiedEnvelope({ preptests: [] }, { schemaVersion: 11 });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
    vi.stubGlobal('fetch', fetchMock);

    const out = await exportUnifiedBackup();
    expect(out.exportId).toBe(envelope.exportId);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/export/backup');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.host_data).toMatchObject({ schemaVersion: 11 });
  });

  it('throws a UnifiedBackupError when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(exportUnifiedBackup()).rejects.toBeInstanceOf(UnifiedBackupError);
  });

  it('throws on a non-2xx backend response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(exportUnifiedBackup()).rejects.toBeInstanceOf(UnifiedBackupError);
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
});
