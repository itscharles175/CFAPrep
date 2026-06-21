// GAP-PORT-1 — tests for the self-describing, per-store-checksummed vault archive.
//
// Covers: build+verify round-trip (host-only and host+lsat), tamper detection
// (flip a byte -> a precise per-store checksum mismatch), row-count drift,
// store add/drop after sealing, archive-version forward-incompatibility, and
// schema-version skew. Plus one real fake-indexeddb round-trip proving an
// archive built from a live Dexie export still verifies after an export -> wipe
// -> import cycle (the same property the CI drill asserts headlessly).
//
// Fully offline: fake-indexeddb is auto-installed via src/setupTests.js; no
// sidecar, no LLM, no network, no DOM.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildVaultArchive,
  verifyVaultArchive,
  VAULT_ARCHIVE_VERSION,
  type VaultArchive,
} from './vaultArchive';
import type { VaultExport } from '../progressStore';
import {
  VAULT_SCHEMA_VERSION,
  VAULT_SCHEMA_HASH,
  VAULT_CONTENT_VERSION,
  exportVaultData,
  importVaultData,
  resetVaultData,
  recordQuizAttempt,
} from '../progressStore';

// A minimal-but-faithful VaultExport with a couple of populated stores. The
// archive only reads `stores` (array-valued) + the schema-version scalars, so a
// trimmed but correctly-shaped export is sufficient and keeps the test readable.
function makeHostExport(overrides: Partial<VaultExport> = {}): VaultExport {
  return {
    app: 'QuantVault',
    exportId: 'test-export-1',
    schemaVersion: VAULT_SCHEMA_VERSION,
    schemaHash: VAULT_SCHEMA_HASH,
    contentVersion: VAULT_CONTENT_VERSION,
    exportedAt: '2026-06-20T00:00:00.000Z',
    checksum: 'sha256:placeholder',
    stores: {
      lessonProgress: [],
      quizAttempts: [],
      questionResults: [
        { domain: 'cfa', topic: 'fixed-income', questionId: 'q1', learningObjective: 'lo1', createdAt: 'x' },
      ],
      reviewItems: [{ id: 'r1' }],
      masterySnapshots: [],
      mockAttempts: [],
      vignetteAttempts: [],
      constructedResponseAttempts: [],
      formulaDrillAttempts: [],
      skillLabAttempts: [],
      studySessions: [],
      studyPlanSettings: [],
      contentVersions: [],
      reviewEvents: [],
      confidenceCalibration: [],
      flashcardAttempts: [],
      resultArtifacts: [],
      mockSectionState: [],
      learningEvents: [],
      vaultHealthSnapshots: [],
      rollbackSnapshots: [],
      calculatorScenarios: [],
      releaseRunHistory: [],
      importJobs: [],
      sourceBundleManifests: [],
      psychometricStats: [],
      mockBlueprints: [],
      notes: [{ id: 'n1' }],
      bookmarks: [],
      settings: [{ key: 'k', value: 1, updatedAt: 'x' }],
    },
    ...overrides,
  } as VaultExport;
}

const sampleLsat = (): Record<string, unknown> => ({
  schema_version: 7,
  preptests: [],
  unsectioned_questions: [{ id: 'lq1', source: 'generated' }],
  study_plans: [{ id: 'sp1' }],
});

describe('buildVaultArchive + verifyVaultArchive', () => {
  it('builds a self-describing manifest and verifies a clean host-only round-trip', () => {
    const archive = buildVaultArchive(makeHostExport(), { appVersion: '1.2.3' });

    expect(archive.manifest.archiveVersion).toBe(VAULT_ARCHIVE_VERSION);
    expect(archive.manifest.appVersion).toBe('1.2.3');
    expect(archive.manifest.schemaVersions.host).toBe(VAULT_SCHEMA_VERSION);
    expect(archive.manifest.schemaVersions.hostSchemaHash).toBe(VAULT_SCHEMA_HASH);
    expect(archive.manifest.schemaVersions.hostContentVersion).toBe(VAULT_CONTENT_VERSION);
    expect(archive.manifest.schemaVersions.lsat).toBeUndefined();

    // Stores are name-prefixed, stable-sorted, and carry count + a 64-char digest.
    const names = archive.manifest.stores.map((s) => s.name);
    expect(names).toContain('host:questionResults');
    expect(names).toContain('host:notes');
    expect([...names]).toEqual([...names].sort());
    const qr = archive.manifest.stores.find((s) => s.name === 'host:questionResults')!;
    expect(qr.count).toBe(1);
    expect(qr.sha256).toMatch(/^[0-9a-f]{64}$/);

    // No timestamp in the manifest (caller stamps it) → archive is a pure fn of data.
    expect('createdAt' in archive.manifest).toBe(false);

    const result = verifyVaultArchive(archive);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('digests the LSAT bank payload and records its schema version', () => {
    const archive = buildVaultArchive(makeHostExport(), { lsatPayload: sampleLsat() });
    expect(archive.manifest.schemaVersions.lsat).toBe(7);
    const names = archive.manifest.stores.map((s) => s.name);
    expect(names).toContain('lsat:unsectioned_questions');
    expect(names).toContain('lsat:study_plans');
    // Non-array bank fields (schema_version scalar) are NOT per-store digested.
    expect(names).not.toContain('lsat:schema_version');

    expect(verifyVaultArchive(archive).ok).toBe(true);
  });

  it('is deterministic: identical inputs yield identical per-store digests', () => {
    const a = buildVaultArchive(makeHostExport());
    const b = buildVaultArchive(makeHostExport());
    expect(a.manifest.stores).toEqual(b.manifest.stores);
  });
});

describe('tamper detection', () => {
  it('flips a byte in a stored row -> a precise checksum mismatch (manifest unchanged)', () => {
    const archive = buildVaultArchive(makeHostExport());
    expect(verifyVaultArchive(archive).ok).toBe(true);

    // Corrupt a single field in the payload WITHOUT touching the sealed manifest
    // digest — exactly what disk corruption / a hand-edit looks like.
    const tampered: VaultArchive = JSON.parse(JSON.stringify(archive));
    (tampered.payload.host.stores.questionResults[0] as unknown as Record<string, unknown>).questionId =
      'q1-TAMPERED';

    const result = verifyVaultArchive(tampered);
    expect(result.ok).toBe(false);
    const checksumMiss = result.mismatches.filter((m) => m.kind === 'checksum');
    expect(checksumMiss).toHaveLength(1);
    expect(checksumMiss[0].name).toBe('host:questionResults');
    expect(checksumMiss[0].expected).not.toBe(checksumMiss[0].actual);
  });

  it('detects a dropped row as both a count and a checksum mismatch (truncation)', () => {
    const archive = buildVaultArchive(makeHostExport());
    const truncated: VaultArchive = JSON.parse(JSON.stringify(archive));
    truncated.payload.host.stores.questionResults = [];

    const result = verifyVaultArchive(truncated);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'count' && m.name === 'host:questionResults')).toBe(true);
    expect(result.mismatches.some((m) => m.kind === 'checksum' && m.name === 'host:questionResults')).toBe(true);
  });

  it('flags a payload store that was added after the manifest was sealed', () => {
    const archive = buildVaultArchive(makeHostExport());
    const mutated: VaultArchive = JSON.parse(JSON.stringify(archive));
    (mutated.payload.host.stores as Record<string, unknown>).smuggled = [{ id: 'x' }];

    const result = verifyVaultArchive(mutated);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'store-extra' && m.name === 'host:smuggled')).toBe(true);
  });

  it('flags a payload store the manifest claims but the payload no longer has', () => {
    const archive = buildVaultArchive(makeHostExport());
    const mutated: VaultArchive = JSON.parse(JSON.stringify(archive));
    delete (mutated.payload.host.stores as Record<string, unknown>).notes;

    const result = verifyVaultArchive(mutated);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'store-missing' && m.name === 'host:notes')).toBe(true);
  });
});

describe('version-skew detection', () => {
  it('refuses an archive whose archiveVersion is newer than this build', () => {
    const archive = buildVaultArchive(makeHostExport());
    const future: VaultArchive = JSON.parse(JSON.stringify(archive));
    future.manifest.archiveVersion = VAULT_ARCHIVE_VERSION + 1;

    const result = verifyVaultArchive(future);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'archive-version')).toBe(true);
  });

  it('detects host schema-version skew between manifest and payload', () => {
    const archive = buildVaultArchive(makeHostExport());
    const skewed: VaultArchive = JSON.parse(JSON.stringify(archive));
    // Payload now claims a different host schema than the manifest sealed.
    skewed.payload.host.schemaVersion = VAULT_SCHEMA_VERSION + 5;

    const result = verifyVaultArchive(skewed);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'schema-version' && m.name === 'schemaVersions.host')).toBe(true);
  });

  it('detects host schema-HASH skew (same number, different shape)', () => {
    const archive = buildVaultArchive(makeHostExport());
    const skewed: VaultArchive = JSON.parse(JSON.stringify(archive));
    skewed.payload.host.schemaHash = 'qv-vNN-some-other-shape';

    const result = verifyVaultArchive(skewed);
    expect(result.ok).toBe(false);
    expect(
      result.mismatches.some((m) => m.kind === 'schema-version' && m.name === 'schemaVersions.hostSchemaHash'),
    ).toBe(true);
  });

  it('detects LSAT schema-version skew', () => {
    const archive = buildVaultArchive(makeHostExport(), { lsatPayload: sampleLsat() });
    const skewed: VaultArchive = JSON.parse(JSON.stringify(archive));
    (skewed.payload.lsat as Record<string, unknown>).schema_version = 999;

    const result = verifyVaultArchive(skewed);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'schema-version' && m.name === 'schemaVersions.lsat')).toBe(true);
  });

  it('reports a malformed (non-object) archive without throwing', () => {
    expect(verifyVaultArchive(null).ok).toBe(false);
    expect(verifyVaultArchive(42).ok).toBe(false);
    expect(verifyVaultArchive({ manifest: {} }).ok).toBe(false);
  });
});

describe('live Dexie round-trip (export -> wipe -> import re-verifies)', () => {
  beforeEach(async () => {
    await resetVaultData('full');
  });

  it('an archive built from a live export still verifies after a wipe+restore cycle', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'fixed-income',
      title: 'Archive Round-Trip',
      mode: 'topic-drill',
      score: 1,
      total: 1,
      elapsedSeconds: 30,
      answers: [
        {
          level: 'level1',
          questionId: 'archive-rt-1',
          learningObjective: 'archive-rt-lo',
          objectiveTitle: 'Archive round-trip objective',
          correct: true,
          confidence: 'high',
          errorCategory: 'concept',
          difficulty: 'foundation',
          selected: 1,
          correctIndex: 1,
          itemType: 'single',
          path: '/cfa/level1/fixed-income/quiz',
        },
      ],
    });

    const exported = (await exportVaultData()) as VaultExport;
    const original = buildVaultArchive(exported, { appVersion: 'test' });
    expect(verifyVaultArchive(original).ok).toBe(true);

    // WIPE, then restore the export back into a clean vault.
    await resetVaultData('full');
    await importVaultData(exported, 'replace');

    // Re-export the restored vault and rebuild the archive — the per-store
    // digests for the rows we seeded must match the original byte-for-byte.
    const reExported = (await exportVaultData()) as VaultExport;
    const rebuilt = buildVaultArchive(reExported, { appVersion: 'test' });
    expect(verifyVaultArchive(rebuilt).ok).toBe(true);

    const origQr = original.manifest.stores.find((s) => s.name === 'host:questionResults')!;
    const rebuiltQr = rebuilt.manifest.stores.find((s) => s.name === 'host:questionResults')!;
    expect(rebuiltQr.count).toBe(origQr.count);
    expect(rebuiltQr.sha256).toBe(origQr.sha256);
  });
});
