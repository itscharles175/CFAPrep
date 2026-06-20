import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMockSectionState,
  exportVaultData,
  forecastReviewLoad,
  getAnalyticsSummary,
  getConfidenceCalibration,
  getMockSectionState,
  getReadinessByTopic,
  getReadinessByLevel,
  getReadinessByObjective,
  getReadinessByObjectiveV2,
  getProgressSummary,
  getResultArtifacts,
  getReviewInbox,
  getStudyPlan,
  getStudyPlanSettings,
  getVaultHealthReport,
  getVaultImportHistory,
  getRollbackSnapshots,
  importVaultData,
  migrateVaultData,
  previewVaultImportPayload,
  previewVaultImport,
  recordFlashcardResult,
  recordLearningEventEnvelope,
  recordConstructedResponseAttempt,
  recordFormulaDrillAttempt,
  recordMockAttempt,
  recordQuizAttempt,
  recordSkillLabAttempt,
  recordStudyEvent,
  recordVignetteAttempt,
  rebuildLearningIndexes,
  repairVaultData,
  resetVaultData,
  restoreRollbackSnapshot,
  db,
  saveNote,
  saveMockSectionState,
  saveResultArtifact,
  saveStudyPlanSettings,
  attachArtifactToNote,
  exportArtifactCsv,
  exportMockSummary,
  getExamPlan,
  VAULT_CONTENT_VERSION,
  VAULT_SCHEMA_HASH,
  VAULT_SCHEMA_VERSION,
  validateVaultData,
} from './progressStore';
import { buildCfaSourceBundle, importCfaSourceBundle } from './cfaSourceVault';
import type { CfaSourceChunk, CfaSourceDocument } from './cfaSourceTypes';

const sourceImportedAt = '2026-05-06T12:00:00.000Z';

function sourceDocumentRow(overrides: Partial<CfaSourceDocument> = {}): CfaSourceDocument {
  return {
    id: 'source:progress-store-doc',
    title: 'Synthetic Source Fixture',
    level: 'level1',
    year: 2026,
    publisher: 'Synthetic Fixture',
    sourceKind: 'user-source',
    format: 'epub',
    sha256: 'hash-progress-store-doc',
    logicalHash: 'logical-progress-store-doc',
    sizeBytes: 256,
    canonical: true,
    coverageTags: ['level1', 'ethics'],
    topicIds: ['ethics'],
    chunkCount: 1,
    importedAt: sourceImportedAt,
    privateUseOnly: true,
    ...overrides,
  };
}

function sourceChunkRow(overrides: Partial<CfaSourceChunk> = {}): CfaSourceChunk {
  return {
    id: 'source:progress-store-doc:chunk:0001',
    documentId: 'source:progress-store-doc',
    chunkIndex: 0,
    locator: 'chapter 1',
    heading: 'Private ethics notes',
    text: 'Private synthetic source text for explicit backup inclusion tests.',
    normalizedText: 'private synthetic source text for explicit backup inclusion tests',
    topicIds: ['ethics'],
    sourceHash: 'hash-progress-store-doc',
    importedAt: sourceImportedAt,
    ...overrides,
  };
}

describe('local vault progress store', () => {
  beforeEach(async () => {
    await resetVaultData('full');
  });

  it('records quiz attempts into mastery and weak objective state', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'economics',
      title: 'Economics',
      mode: 'topic-drill',
      score: 0,
      total: 1,
      elapsedSeconds: 30,
      answers: [
        {
          questionId: 'econ-1',
          learningObjective: 'econ-lo1',
          objectiveTitle: 'Analyze market forces and elasticity',
          correct: false,
          confidence: 'low',
          errorCategory: 'concept',
          difficulty: 'foundation',
          selected: 0,
          correctIndex: 3,
        },
      ],
    });

    const summary = await getProgressSummary();
    expect(summary.questionsAnswered).toBe(1);
    expect(summary.studyTimeSeconds).toBe(30);
    expect(summary.weakObjectives[0]?.learningObjective).toBe('econ-lo1');
    expect(summary.todayRecommendation.path).toContain('/cfa/level1/economics/quiz');
  });

  it('exports, validates, resets, and imports local vault JSON', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'portfolio',
      title: 'Portfolio Management',
      mode: 'mock-section',
      score: 1,
      total: 1,
      elapsedSeconds: 20,
      answers: [
        {
          questionId: 'pm-1',
          learningObjective: 'pm-lo1',
          objectiveTitle: 'Build portfolio risk and return intuition',
          correct: true,
          confidence: 'high',
          errorCategory: 'none',
          difficulty: 'foundation',
          selected: 1,
          correctIndex: 1,
        },
      ],
    });

    const exported = await exportVaultData();
    expect(exported).toMatchObject({
      app: 'QuantVault',
      schemaVersion: VAULT_SCHEMA_VERSION,
      schemaHash: VAULT_SCHEMA_HASH,
      contentVersion: VAULT_CONTENT_VERSION,
      encryption: { encrypted: false, algorithm: 'none' },
    });
    expect(exported.exportId).toMatch(/^qv-/);
    expect(exported.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(exported.stores.reviewItems[0].fsrsDifficulty).toBeTypeOf('number');
    expect(exported.stores.learningEvents).toEqual([]);
    expect(exported.stores.vaultHealthSnapshots).toEqual([]);
    expect(exported.stores.rollbackSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(exported.stores.calculatorScenarios).toEqual([]);
    expect(exported.stores.importJobs).toEqual([]);
    expect(exported.stores.mockBlueprints).toEqual([]);
    expect(validateVaultData(exported)).toEqual({ valid: true, errors: [] });

    await resetVaultData('full');
    expect((await getProgressSummary()).questionsAnswered).toBe(0);

    await importVaultData(exported, 'replace');
    expect((await getProgressSummary()).questionsAnswered).toBe(1);
  });

  it('rejects a backup from a newer schema version instead of down-converting it (audit M5)', async () => {
    const exported = await exportVaultData();
    const result = validateVaultData({ ...exported, schemaVersion: VAULT_SCHEMA_VERSION + 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/newer app version/i);
  });

  it('rejects a backup carrying unknown data stores instead of silently dropping them (audit M5)', async () => {
    const exported = await exportVaultData();
    const result = validateVaultData({ ...exported, stores: { ...exported.stores, futureOnlyStore: [{ id: 'x' }] } });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown data store/i);
  });

  it('repair filters malformed rows and re-checksums so the replace-import is accepted (audit M2)', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'portfolio',
      title: 'Portfolio Management',
      mode: 'mock-section',
      score: 1,
      total: 1,
      elapsedSeconds: 20,
      answers: [
        {
          questionId: 'pm-1',
          learningObjective: 'pm-lo1',
          objectiveTitle: 'Build portfolio risk and return intuition',
          correct: true,
          confidence: 'high',
          errorCategory: 'none',
          difficulty: 'foundation',
          selected: 1,
          correctIndex: 1,
        },
      ],
    });
    // Inject a corrupt questionResult (no learningObjective) that repair must drop.
    await db.questionResults.add({
      id: 'corrupt-row',
      domain: 'cfa',
      topic: 'portfolio',
      questionId: 'broken',
      learningObjective: '',
      correct: false,
      confidence: 'low',
      errorCategory: 'concept',
      difficulty: 'foundation',
      createdAt: new Date().toISOString(),
    } as never);
    const before = await db.questionResults.count();
    // Previously threw (stale checksum rejected the filtered payload); now resolves.
    await expect(repairVaultData()).resolves.toBeDefined();
    const after = await db.questionResults.count();
    expect(after).toBeLessThan(before);
    expect((await getProgressSummary()).questionsAnswered).toBe(1);
  });

  it('restores the vault from a rollback snapshot (audit M1)', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'equity',
      title: 'Equity',
      mode: 'mock-section',
      score: 1,
      total: 1,
      elapsedSeconds: 15,
      answers: [
        {
          questionId: 'eq-1',
          learningObjective: 'eq-lo1',
          objectiveTitle: 'Value equity securities',
          correct: true,
          confidence: 'medium',
          errorCategory: 'none',
          difficulty: 'foundation',
          selected: 0,
          correctIndex: 0,
        },
      ],
    });
    expect((await getProgressSummary()).questionsAnswered).toBe(1);
    // resetVaultData snapshots the 1-attempt state BEFORE clearing.
    await resetVaultData('full');
    expect((await getProgressSummary()).questionsAnswered).toBe(0);
    const resetSnapshot = (await getRollbackSnapshots()).find((snap) => snap.reason === 'reset');
    expect(resetSnapshot).toBeDefined();
    await restoreRollbackSnapshot(resetSnapshot!.id);
    expect((await getProgressSummary()).questionsAnswered).toBe(1);
  });

  it('encrypts vault backups and rejects the wrong passphrase', async () => {
    await saveStudyPlanSettings({ dailyTargetMinutes: 75, targetLevel: 'level3' });

    const encrypted = await exportVaultData({ encryption: { passphrase: 'correct horse battery staple' } });
    expect(encrypted.encryption).toMatchObject({
      encrypted: true,
      algorithm: 'AES-GCM',
      keyDerivation: 'PBKDF2',
      hash: 'SHA-256',
    });
    expect(encrypted.payload).toBeTypeOf('string');
    expect('stores' in encrypted).toBe(false);
    expect(validateVaultData(encrypted).valid).toBe(false);

    await resetVaultData('full');
    await expect(importVaultData(encrypted, { mode: 'replace', passphrase: 'wrong passphrase' })).rejects.toThrow(/decrypt/i);
    await importVaultData(encrypted, { mode: 'replace', passphrase: 'correct horse battery staple' });

    const restored = await getStudyPlanSettings();
    const history = await getVaultImportHistory();
    const snapshots = await getRollbackSnapshots();
    const restoredExport = await exportVaultData();
    expect(restored.dailyTargetMinutes).toBe(75);
    expect(restored.targetLevel).toBe('level3');
    expect(history[0]).toMatchObject({ schemaVersion: VAULT_SCHEMA_VERSION, encrypted: true, mode: 'replace' });
    expect(snapshots.some((snapshot) => snapshot.reason === 'import-replace')).toBe(true);
    expect(restoredExport.stores.importJobs[0]).toMatchObject({ status: 'ok', encrypted: true, mode: 'replace' });
  });

  it('keeps source vault text out of exports unless explicitly included', async () => {
    await importCfaSourceBundle(buildCfaSourceBundle({ documents: [sourceDocumentRow()], chunks: [sourceChunkRow()] }));

    const standardExport = await exportVaultData();
    const explicitExport = await exportVaultData({ includeSourceVault: true });
    const encryptedExplicitExport = await exportVaultData({
      includeSourceVault: true,
      encryption: { passphrase: 'source backup passphrase' },
    });
    const encryptedPreview = await previewVaultImportPayload(encryptedExplicitExport, {
      passphrase: 'source backup passphrase',
      includeSourceVault: true,
    });

    expect(standardExport.sourceVault).toBeUndefined();
    expect(explicitExport.sourceVault?.sourceChunks[0].text).toContain('Private synthetic source text');
    expect(encryptedPreview.sourceAvailable).toBe(true);
    expect(encryptedPreview.sourceIncluded).toBe(true);
    expect(encryptedPreview.sourceCounts.sourceChunks).toBe(1);
  });

  it('previews encrypted imports after decryption and reports merge conflicts', async () => {
    await saveStudyPlanSettings({ dailyTargetMinutes: 45, targetLevel: 'level1' });
    const encrypted = await exportVaultData({ encryption: { passphrase: 'preview passphrase' } });

    await resetVaultData('full');
    await saveStudyPlanSettings({ dailyTargetMinutes: 90, targetLevel: 'level2' });

    const lockedPreview = await previewVaultImportPayload(encrypted);
    const wrongPassphrasePreview = await previewVaultImportPayload(encrypted, { passphrase: 'wrong passphrase' });
    const preview = await previewVaultImportPayload(encrypted, {
      mode: 'merge',
      passphrase: 'preview passphrase',
      conflictPolicy: 'keep-existing',
    });

    expect(lockedPreview.valid).toBe(false);
    expect(lockedPreview.errors[0]).toMatch(/passphrase/i);
    expect(wrongPassphrasePreview.valid).toBe(false);
    expect(wrongPassphrasePreview.errors[0]).toMatch(/decrypt/i);
    expect(preview.valid).toBe(true);
    expect(preview.encrypted).toBe(true);
    expect(preview.totalRows).toBeGreaterThan(0);
    expect(preview.conflicts.byStore.studyPlanSettings).toBe(1);
    expect(preview.conflictPolicy).toBe('keep-existing');

    await importVaultData(encrypted, { mode: 'merge', passphrase: 'preview passphrase', conflictPolicy: 'keep-existing' });
    expect((await getStudyPlanSettings()).dailyTargetMinutes).toBe(90);
  });

  it('supports keep-existing and prefer-import merge conflict policies', async () => {
    await saveStudyPlanSettings({ dailyTargetMinutes: 30, targetLevel: 'level1' });
    const exported = await exportVaultData();

    await resetVaultData('full');
    await saveStudyPlanSettings({ dailyTargetMinutes: 90, targetLevel: 'level2' });

    await importVaultData(exported, { mode: 'merge', conflictPolicy: 'keep-existing' });
    expect((await getStudyPlanSettings()).dailyTargetMinutes).toBe(90);
    expect((await getStudyPlanSettings()).targetLevel).toBe('level2');

    await importVaultData(exported, { mode: 'merge', conflictPolicy: 'prefer-import' });
    expect((await getStudyPlanSettings()).dailyTargetMinutes).toBe(30);
    expect((await getStudyPlanSettings()).targetLevel).toBe('level1');
  });

  it('rebuilds derived review indexes after import and repair-style cleanup', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'level2:equity',
      title: 'Equity Valuation',
      mode: 'topic-drill',
      score: 0,
      total: 1,
      elapsedSeconds: 42,
      answers: [
        {
          level: 'level2',
          questionId: 'l2-eq-1',
          learningObjective: 'level2-equity-risk',
          objectiveTitle: 'Identify model risk in Equity Valuation',
          correct: false,
          confidence: 'low',
          errorCategory: 'concept',
          difficulty: 'advanced',
          selected: 0,
          correctIndex: 1,
          itemType: 'single',
        },
      ],
    });

    const exported = await exportVaultData();
    exported.stores.reviewItems = [];
    exported.stores.masterySnapshots = [];
    exported.stores.reviewEvents = [];
    exported.stores.confidenceCalibration = [];
    delete (exported as Partial<typeof exported>).checksum;

    await resetVaultData('full');
    await importVaultData(exported, 'replace');
    const restored = await exportVaultData();

    expect(restored.stores.questionResults).toHaveLength(1);
    expect(restored.stores.reviewItems).toHaveLength(1);
    expect(restored.stores.masterySnapshots).toHaveLength(1);
    expect(restored.stores.confidenceCalibration).toHaveLength(1);
    expect((await getReviewInbox()).some((item) => item.type === 'weak-objective')).toBe(true);
  });

  it('keeps merge imports collision-safe for auto-increment attempt rows', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'economics',
      title: 'Economics',
      mode: 'topic-drill',
      score: 1,
      total: 1,
      elapsedSeconds: 20,
      answers: [
        {
          questionId: 'econ-merge',
          learningObjective: 'econ-merge-lo',
          objectiveTitle: 'Merge import objective',
          correct: true,
          confidence: 'high',
          errorCategory: 'none',
          difficulty: 'foundation',
          selected: 0,
          correctIndex: 0,
        },
      ],
    });

    const exported = await exportVaultData();
    await importVaultData(exported, 'merge');
    const merged = await exportVaultData();

    expect(merged.stores.quizAttempts).toHaveLength(2);
    expect(merged.stores.questionResults).toHaveLength(2);
    expect(merged.stores.reviewItems).toHaveLength(1);
  });

  it('builds review inbox, readiness, and study plan from local results', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'fixed-income',
      title: 'Fixed Income',
      mode: 'topic-drill',
      score: 0,
      total: 1,
      elapsedSeconds: 25,
      answers: [
        {
          questionId: 'fi-3',
          learningObjective: 'fi-lo2',
          objectiveTitle: 'Measure duration, convexity, and interest-rate risk',
          correct: false,
          confidence: 'low',
          errorCategory: 'calculation',
          difficulty: 'intermediate',
          selected: 0,
          correctIndex: 1,
        },
      ],
    });

    const inbox = await getReviewInbox();
    const readiness = await getReadinessByTopic();
    const plan = await getStudyPlan({ examDate: '2026-12-31', dailyTargetMinutes: 60 });
    const forecast = await forecastReviewLoad(7);

    expect(inbox.some((item) => item.type === 'weak-objective')).toBe(true);
    expect(inbox.every((item) => item.reason)).toBe(true);
    expect(readiness[0].topic).toBe('fixed-income');
    expect(plan.dailyTargetMinutes).toBe(60);
    expect(plan.planVersion).toBe(2);
    expect(plan.reviewLoad).toHaveLength(14);
    expect(plan.nextActions.length).toBeGreaterThan(0);
    expect(forecast).toHaveLength(7);
    expect(forecast[0]).toHaveProperty('atRiskCount');
    expect(forecast.some((day) => day.count > 0 && typeof day.averageRetention === 'number')).toBe(true);
  });

  it('records mock attempts into local readiness state', async () => {
    await recordMockAttempt({
      domain: 'cfa',
      level: 'level1',
      title: 'Test Mock',
      mode: 'mock-section',
      score: 1,
      total: 2,
      elapsedSeconds: 90,
      flaggedQuestionIds: ['econ-1'],
      answers: [
        {
          topic: 'economics',
          questionId: 'econ-1',
          learningObjective: 'econ-lo1',
          objectiveTitle: 'Analyze market forces and elasticity',
          correct: true,
          confidence: 'medium',
          errorCategory: 'none',
          difficulty: 'foundation',
          selected: 3,
          correctIndex: 3,
        },
        {
          topic: 'portfolio',
          questionId: 'pm-3',
          learningObjective: 'pm-lo2',
          objectiveTitle: 'Apply CAPM and portfolio construction concepts',
          correct: false,
          confidence: 'low',
          errorCategory: 'formula',
          difficulty: 'intermediate',
          selected: 0,
          correctIndex: 2,
        },
      ],
    });

    const exported = await exportVaultData();
    expect(exported.stores.mockAttempts).toHaveLength(1);
    expect((await getProgressSummary()).questionsAnswered).toBe(2);
    expect((await getReadinessByTopic()).length).toBeGreaterThan(0);
  });

  it('previews and migrates older vault exports', () => {
    const oldExport = {
      app: 'QuantVault',
      schemaVersion: 2,
      exportedAt: '2026-05-02T00:00:00.000Z',
      stores: {
        lessonProgress: [],
        quizAttempts: [],
        questionResults: [],
        reviewItems: [],
        masterySnapshots: [],
        studySessions: [],
        notes: [],
        bookmarks: [],
        settings: [],
      },
    };

    const migrated = migrateVaultData(oldExport);
    expect(migrated.schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(migrated.schemaHash).toBe(VAULT_SCHEMA_HASH);
    expect(migrated.contentVersion).toBe(VAULT_CONTENT_VERSION);
    expect(migrated.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(migrated.stores.mockAttempts).toEqual([]);
    expect(migrated.stores.vignetteAttempts).toEqual([]);
    expect(migrated.stores.constructedResponseAttempts).toEqual([]);
    expect(migrated.stores.formulaDrillAttempts).toEqual([]);
    expect(migrated.stores.skillLabAttempts).toEqual([]);
    expect(migrated.stores.studyPlanSettings).toEqual([]);
    expect(migrated.stores.reviewEvents).toEqual([]);
    expect(migrated.stores.confidenceCalibration).toEqual([]);
    expect(migrated.stores.flashcardAttempts).toEqual([]);
    expect(migrated.stores.resultArtifacts).toEqual([]);
    expect(migrated.stores.mockSectionState).toEqual([]);
    expect(migrated.stores.learningEvents).toEqual([]);
    expect(migrated.stores.vaultHealthSnapshots).toEqual([]);
    expect(migrated.stores.rollbackSnapshots).toEqual([]);
    expect(migrated.stores.calculatorScenarios).toEqual([]);
    expect(migrated.stores.releaseRunHistory).toEqual([]);
    expect(migrated.stores.importJobs).toEqual([]);
    expect(migrated.stores.sourceBundleManifests).toEqual([]);
    expect(migrated.stores.psychometricStats).toEqual([]);
    expect(migrated.stores.mockBlueprints).toEqual([]);
    expect(previewVaultImport(oldExport)).toMatchObject({
      valid: true,
      schemaVersion: VAULT_SCHEMA_VERSION,
      schemaHash: VAULT_SCHEMA_HASH,
      contentVersion: VAULT_CONTENT_VERSION,
      checksumValid: true,
    });
  });

  it('rejects invalid import payloads', () => {
    const validation = validateVaultData({ app: 'Other', stores: {} });
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('rejects source vault links whose citation document does not match the chunk document', async () => {
    const exported = await exportVaultData();
    delete (exported as Partial<typeof exported>).checksum;
    exported.sourceVault = {
      sourceDocuments: [
        {
          id: 'source:doc-a',
          title: 'Doc A',
          level: 'level1',
          publisher: 'Synthetic',
          sourceKind: 'user-source',
          format: 'epub',
          sha256: 'hash-a',
          sizeBytes: 100,
          canonical: true,
          coverageTags: [],
          topicIds: ['fixed-income'],
          chunkCount: 1,
          importedAt: '2026-05-06T00:00:00.000Z',
          privateUseOnly: true,
        },
        {
          id: 'source:doc-b',
          title: 'Doc B',
          level: 'level1',
          publisher: 'Synthetic',
          sourceKind: 'user-source',
          format: 'epub',
          sha256: 'hash-b',
          sizeBytes: 100,
          canonical: true,
          coverageTags: [],
          topicIds: ['fixed-income'],
          chunkCount: 0,
          importedAt: '2026-05-06T00:00:00.000Z',
          privateUseOnly: true,
        },
      ],
      sourceChunks: [
        {
          id: 'source:doc-a:chunk:0001',
          documentId: 'source:doc-a',
          chunkIndex: 0,
          locator: 'chunk 1',
          text: 'Fixed income private source text.',
          normalizedText: 'fixed income private source text',
          topicIds: ['fixed-income'],
          sourceHash: 'hash-a',
          importedAt: '2026-05-06T00:00:00.000Z',
        },
      ],
      sourceIndexes: [],
      sourceIngestionRuns: [],
      sourceLinks: [
        {
          id: 'target::chunk',
          targetId: 'target',
          targetKind: 'module',
          documentId: 'source:doc-b',
          chunkId: 'source:doc-a:chunk:0001',
          score: 1,
          rank: 1,
          sourcePriority: 'user-source',
          matchedTerms: ['fixed'],
          rankReason: 'fixture',
          createdAt: '2026-05-06T00:00:00.000Z',
        },
      ],
      sourceLinkOverrides: [],
    };

    const validation = validateVaultData(exported);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes('mismatched source document citations'))).toBe(true);
  });

  it('rejects tampered v6 vault checksums', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'ethics',
      title: 'Ethics',
      score: 1,
      total: 1,
      elapsedSeconds: 10,
      answers: [
        {
          questionId: 'ethics-checksum',
          learningObjective: 'ethics-checksum-lo',
          objectiveTitle: 'Protect vault export integrity',
          correct: true,
          confidence: 'high',
          errorCategory: 'none',
          difficulty: 'foundation',
        },
      ],
    });

    const exported = await exportVaultData();
    exported.stores.questionResults[0].correct = false;
    const validation = validateVaultData(exported);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Vault export checksum does not match its payload.');
  });

  it('persists study planner settings and records non-quiz study events', async () => {
    await saveStudyPlanSettings({
      dailyTargetMinutes: 90,
      examDate: '2026-11-15',
      restDays: [0, 6, 9],
    });
    await recordStudyEvent({
      domain: 'cfa',
      topic: 'ethics',
      mode: 'reading',
      startedAt: '2026-05-04T12:00:00.000Z',
      endedAt: '2026-05-04T12:30:00.000Z',
      elapsedSeconds: 1800,
      questionsAnswered: 0,
      score: 0,
    });
    await recordLearningEventEnvelope({
      id: 'event:lesson:ethics',
      schemaVersion: 1,
      event: {
        domain: 'cfa',
        topic: 'ethics',
        mode: 'reading',
        sourceType: 'lesson',
        sourceId: 'ethics-lesson-1',
        score: 1,
        total: 1,
        elapsedSeconds: 600,
        createdAt: '2026-05-04T13:00:00.000Z',
      },
      sourceIds: ['ethics-lesson-1'],
      recordedAt: '2026-05-04T13:10:00.000Z',
    });

    const settings = await getStudyPlanSettings();
    const plan = await getStudyPlan();
    const summary = await getProgressSummary();
    const exported = await exportVaultData();

    expect(settings.dailyTargetMinutes).toBe(90);
    expect(settings.restDays).toEqual([0, 6]);
    expect(plan.examDate).toBe('2026-11-15');
    expect(plan.dailyTargetMinutes).toBe(90);
    expect(summary.studyTimeSeconds).toBe(2400);
    expect(exported.stores.learningEvents).toHaveLength(1);
  });

  it('feeds flashcard outcomes into reviews, mastery, analytics, and calibration', async () => {
    await recordFlashcardResult({
      topic: 'quantitative-methods',
      cardId: 'flash-variance',
      cardType: 'formula',
      title: 'Variance Formula',
      outcome: 'again',
      elapsedSeconds: 15,
    });

    const exported = await exportVaultData();
    const summary = await getProgressSummary();
    const inbox = await getReviewInbox();
    const analytics = await getAnalyticsSummary();
    const calibration = await getConfidenceCalibration();

    expect(exported.stores.flashcardAttempts).toHaveLength(1);
    expect(exported.stores.reviewEvents.length).toBeGreaterThan(0);
    expect(exported.stores.confidenceCalibration).toHaveLength(1);
    expect(summary.questionsAnswered).toBe(1);
    expect(inbox.some((item) => item.title === 'Variance Formula')).toBe(true);
    expect(analytics.totals.flashcardAttempts).toBe(1);
    expect(analytics.byTopic.find((topic) => topic.topic === 'quantitative-methods')?.accuracy).toBe(0);
    expect(calibration.find((bucket) => bucket.confidence === 'low')?.attempts).toBe(1);
  });

  it('stores calculator and lab result artifacts for the personal vault', async () => {
    const artifact = await saveResultArtifact({
      type: 'calculator',
      domain: 'cfa',
      topic: 'fixed-income',
      title: 'Bond Yield Snapshot',
      summary: 'Yield estimate from local calculator assumptions.',
      assumptions: { price: 98, par: 100, years: 5 },
      metrics: { yieldToMaturity: 0.051 },
      path: '/calculators',
    });

    const artifacts = await getResultArtifacts();
    const calculatorArtifacts = await getResultArtifacts('calculator');
    const analytics = await getAnalyticsSummary();

    expect(artifact.id).toContain('calculator:bond-yield-snapshot');
    expect(artifacts).toHaveLength(1);
    expect(calculatorArtifacts[0].metrics.yieldToMaturity).toBe(0.051);
    expect(analytics.totals.artifacts).toBe(1);
  });

  it('persists and clears resumable mock section state', async () => {
    await saveMockSectionState({
      id: 'test-mock-state',
      title: 'CFA Level I Practice Section',
      questionIds: ['econ-1', 'pm-1'],
      selected: { 'econ-1': 2 },
      flaggedQuestionIds: ['pm-1'],
      currentIndex: 1,
      startTime: 12345,
      pausedMs: 5000,
      pausedAt: 67890,
      status: 'paused',
    });

    const state = await getMockSectionState('test-mock-state');
    expect(state?.status).toBe('paused');
    expect(state?.flaggedQuestionIds).toEqual(['pm-1']);

    await clearMockSectionState('test-mock-state');
    expect(await getMockSectionState('test-mock-state')).toBeNull();
  });

  it('adds low scoring mock attempts to the review inbox and analytics', async () => {
    await recordMockAttempt({
      domain: 'cfa',
      level: 'level1',
      title: 'Flagged Mock Section',
      mode: 'mock-section',
      score: 1,
      total: 3,
      elapsedSeconds: 120,
      flaggedQuestionIds: ['econ-1'],
      answers: [
        {
          topic: 'economics',
          questionId: 'econ-1',
          learningObjective: 'econ-lo1',
          objectiveTitle: 'Analyze market forces and elasticity',
          correct: true,
          confidence: 'medium',
          errorCategory: 'none',
          difficulty: 'foundation',
          selected: 3,
          correctIndex: 3,
        },
        {
          topic: 'economics',
          questionId: 'econ-2',
          learningObjective: 'econ-lo2',
          objectiveTitle: 'Interpret macro indicators and policy impacts',
          correct: false,
          confidence: 'high',
          errorCategory: 'misread',
          difficulty: 'intermediate',
          selected: 0,
          correctIndex: 1,
        },
        {
          topic: 'portfolio',
          questionId: 'pm-2',
          learningObjective: 'pm-lo2',
          objectiveTitle: 'Apply CAPM and portfolio construction concepts',
          correct: false,
          confidence: 'low',
          errorCategory: 'formula',
          difficulty: 'advanced',
          selected: 1,
          correctIndex: 2,
        },
      ],
    });

    const inbox = await getReviewInbox();
    const analytics = await getAnalyticsSummary();

    expect(inbox.some((item) => item.type === 'mock-review' && item.title === 'Flagged Mock Section')).toBe(true);
    expect(analytics.totals.mockAttempts).toBe(1);
    expect(analytics.byDifficulty.find((row) => row.difficulty === 'advanced')?.attempts).toBe(1);
    expect(analytics.byErrorCategory.some((row) => row.errorCategory === 'formula')).toBe(true);
  });

  it('records vignette attempts into scheduler, readiness, and level analytics', async () => {
    await recordVignetteAttempt({
      domain: 'cfa',
      level: 'level2',
      topic: 'level2:equity',
      vignetteId: 'level2-equity-vignette-1',
      title: 'Equity Item Set',
      score: 1,
      total: 2,
      elapsedSeconds: 180,
      answers: [
        {
          level: 'level2',
          topic: 'level2:equity',
          questionId: 'l2-eq-v1-q1',
          learningObjective: 'level2-equity-valuation',
          objectiveTitle: 'Connect assumptions to valuation or allocation outcomes in Equity Valuation',
          correct: true,
          confidence: 'medium',
          errorCategory: 'none',
          difficulty: 'intermediate',
          selected: 0,
          correctIndex: 0,
          itemType: 'vignette',
        },
        {
          level: 'level2',
          topic: 'level2:equity',
          questionId: 'l2-eq-v1-q2',
          learningObjective: 'level2-equity-risk',
          objectiveTitle: 'Identify risk, bias, and model limitations in Equity Valuation',
          correct: false,
          confidence: 'low',
          errorCategory: 'concept',
          difficulty: 'advanced',
          selected: 1,
          correctIndex: 0,
          itemType: 'vignette',
        },
      ],
    });

    const exported = await exportVaultData();
    const analytics = await getAnalyticsSummary();
    const readinessByLevel = await getReadinessByLevel();

    expect(exported.stores.vignetteAttempts).toHaveLength(1);
    expect(analytics.totals.vignetteAttempts).toBe(1);
    expect(analytics.byLevel?.find((row) => row.level === 'level2')?.attempts).toBe(2);
    expect(analytics.byItemType?.find((row) => row.itemType === 'vignette')?.attempts).toBe(2);
    expect(readinessByLevel.find((row) => row.level === 'level2')?.topics).toBeGreaterThan(0);
  });

  it('records constructed responses, formula drills, and skill labs as review signals', async () => {
    const artifact = await saveResultArtifact({
      type: 'quant-lab',
      domain: 'quant',
      level: 'level3',
      topic: 'level3:portfolio-construction',
      title: 'Risk Budget Lab',
      summary: 'Risk budget drill output.',
      assumptions: { activeRisk: 4 },
      metrics: { score: 62 },
      path: '/quant/portfolio-optimization',
      objectiveIds: ['level3-portfolio-construction-risk'],
    });

    await recordConstructedResponseAttempt({
      domain: 'cfa',
      level: 'level3',
      topic: 'level3:portfolio-construction',
      itemId: 'cr-1',
      title: 'Portfolio Construction Response',
      earnedPoints: 3,
      maxPoints: 6,
      rubricScores: { identify: 2, apply: 1, justify: 0 },
      response: 'Recommend reducing active risk because constraints dominate return seeking.',
      elapsedSeconds: 240,
      learningObjectives: ['level3-portfolio-construction-risk'],
      path: '/cfa/level3/portfolio-construction/constructed-response',
    });
    await recordFormulaDrillAttempt({
      domain: 'cfa',
      level: 'level1',
      topic: 'fixed-income',
      formulaName: 'Modified Duration',
      correct: false,
      confidence: 'low',
      elapsedSeconds: 25,
    });
    await recordSkillLabAttempt({
      domain: 'quant',
      level: 'level3',
      topic: 'level3:portfolio-construction',
      labId: 'Risk Budget Lab',
      labType: 'quant-lab',
      objectiveIds: ['level3-portfolio-construction-risk'],
      artifactId: artifact.id,
      score: 62,
      elapsedSeconds: 120,
    });
    await attachArtifactToNote(artifact.id, 'artifact-note');

    const exported = await exportVaultData();
    const inbox = await getReviewInbox();
    const analytics = await getAnalyticsSummary();
    const objectives = await getReadinessByObjective();
    const objectivesV2 = await getReadinessByObjectiveV2();
    const csv = await exportArtifactCsv('quant-lab');
    const plan = await getExamPlan();
    const vaultHealth = await getVaultHealthReport();

    expect(exported.stores.constructedResponseAttempts).toHaveLength(1);
    expect(exported.stores.formulaDrillAttempts).toHaveLength(1);
    expect(exported.stores.skillLabAttempts).toHaveLength(1);
    expect(exported.stores.resultArtifacts[0].noteId).toBe('artifact-note');
    expect(inbox.some((item) => item.title === 'Portfolio Construction Response')).toBe(true);
    expect(inbox.some((item) => item.title === 'Modified Duration')).toBe(true);
    expect(analytics.totals.constructedResponseAttempts).toBe(1);
    expect(analytics.totals.skillLabAttempts).toBe(2);
    expect(analytics.essayRubrics?.find((row) => row.criterion === 'justify')?.averagePct).toBe(0);
    expect(objectives.length).toBeGreaterThan(0);
    expect(objectivesV2[0]).toMatchObject({ readinessVersion: 2, primaryReason: expect.any(String) });
    expect(csv).toContain('Risk Budget Lab');
    expect(exportMockSummary(exported.stores.constructedResponseAttempts[0])).toContain('Portfolio Construction Response');
    expect(plan.targetLevel).toBe('level1');
    expect(vaultHealth.schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(vaultHealth.importHistory).toEqual(expect.any(Array));
    expect(await rebuildLearningIndexes()).toMatchObject({ reviewItems: expect.any(Number) });
  });

  it('shares Level III common-core progress while isolating inactive pathway analytics and review rows', async () => {
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'level3:performance',
      title: 'Performance Measurement',
      mode: 'topic-drill',
      score: 0,
      total: 1,
      elapsedSeconds: 30,
      answers: [
        {
          level: 'level3',
          topic: 'level3:performance',
          questionId: 'level3-performance-common',
          learningObjective: 'level3-performance-common-lo',
          objectiveTitle: 'Evaluate performance as common core',
          correct: false,
          confidence: 'low',
          errorCategory: 'concept',
          difficulty: 'intermediate',
        },
      ],
    });
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'level3:private-markets-pathway',
      title: 'Private Markets Pathway',
      mode: 'topic-drill',
      score: 0,
      total: 1,
      elapsedSeconds: 30,
      answers: [
        {
          level: 'level3',
          topic: 'level3:private-markets-pathway',
          questionId: 'level3-private-markets-only',
          learningObjective: 'level3-private-markets-only-lo',
          objectiveTitle: 'Evaluate private markets pathway evidence',
          correct: false,
          confidence: 'low',
          errorCategory: 'concept',
          difficulty: 'advanced',
        },
      ],
    });
    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'level3:private-wealth-pathway',
      title: 'Private Wealth Pathway',
      mode: 'topic-drill',
      score: 0,
      total: 1,
      elapsedSeconds: 30,
      answers: [
        {
          level: 'level3',
          topic: 'level3:private-wealth-pathway',
          questionId: 'level3-private-wealth-only',
          learningObjective: 'level3-private-wealth-only-lo',
          objectiveTitle: 'Evaluate private wealth pathway evidence',
          correct: false,
          confidence: 'low',
          errorCategory: 'concept',
          difficulty: 'advanced',
        },
      ],
    });

    const privateMarketsAnalytics = await getAnalyticsSummary({ level3Pathway: 'private-markets' });
    const privateWealthInbox = await getReviewInbox({ level3Pathway: 'private-wealth' });

    expect(privateMarketsAnalytics.byTopic.map((row) => row.topic)).toContain('level3:performance');
    expect(privateMarketsAnalytics.byTopic.map((row) => row.topic)).toContain('level3:private-markets-pathway');
    expect(privateMarketsAnalytics.byTopic.map((row) => row.topic)).not.toContain('level3:private-wealth-pathway');
    expect(privateWealthInbox.map((item) => item.topic)).toContain('level3:performance');
    expect(privateWealthInbox.map((item) => item.topic)).toContain('level3:private-wealth-pathway');
    expect(privateWealthInbox.map((item) => item.topic)).not.toContain('level3:private-markets-pathway');
  });

  it('explains next-best actions with weighted readiness, rubric, and lab evidence', async () => {
    const artifact = await saveResultArtifact({
      type: 'calculator',
      domain: 'cfa',
      level: 'level3',
      topic: 'level3:portfolio-construction',
      title: 'Contribution Calculator',
      summary: 'Calculator output for portfolio construction objective.',
      assumptions: { activeRisk: 5 },
      metrics: { score: 55 },
      path: '/calculators',
      objectiveIds: ['level3-portfolio-risk'],
    });

    await recordConstructedResponseAttempt({
      domain: 'cfa',
      level: 'level3',
      topic: 'level3:portfolio-construction',
      itemId: 'cr-weighted',
      title: 'Portfolio Risk Response',
      earnedPoints: 2,
      maxPoints: 8,
      rubricScores: { identify: 1, apply: 0, justify: 0, communicate: 1 },
      response: 'Risk is high.',
      elapsedSeconds: 300,
      learningObjectives: ['level3-portfolio-risk'],
      path: '/cfa/level3/portfolio-construction/constructed-response',
    });

    await recordQuizAttempt({
      domain: 'cfa',
      topic: 'level3:portfolio-construction',
      title: 'Portfolio Construction Quiz',
      mode: 'topic-drill',
      score: 1,
      total: 1,
      elapsedSeconds: 30,
      answers: [
        {
          level: 'level3',
          questionId: 'pc-standalone',
          learningObjective: 'level3-portfolio-risk',
          objectiveTitle: 'Evaluate active risk and constraints',
          correct: true,
          confidence: 'high',
          errorCategory: 'none',
          difficulty: 'foundation',
          itemType: 'single',
        },
      ],
    });

    await recordSkillLabAttempt({
      domain: 'cfa',
      level: 'level3',
      topic: 'level3:portfolio-construction',
      labId: 'Contribution Calculator',
      labType: 'calculator',
      objectiveIds: ['level3-portfolio-risk'],
      artifactId: artifact.id,
      score: 55,
      elapsedSeconds: 90,
    });

    const objectives = await getReadinessByObjectiveV2();
    const objective = objectives.find((row) => row.learningObjective === 'level3-portfolio-risk');
    const inbox = await getReviewInbox();
    const analytics = await getAnalyticsSummary();
    const plan = await getStudyPlan();

    expect(objective?.itemTypeWeight).toBeGreaterThan(1);
    expect(objective?.itemTypeAdjustedScore).toBeLessThan(100);
    expect(objective?.readinessScore).toBeLessThan(objective?.masteryScore ?? 100);
    expect(objective?.reasonDetails.length).toBeGreaterThan(0);
    expect(objective?.weaknessSignals.some((signal) => signal.type === 'rubric')).toBe(true);
    expect(objective?.weaknessSignals.some((signal) => signal.type === 'artifact')).toBe(true);
    expect(inbox.find((item) => item.reason === 'rubric-miss')?.reasonDetails?.join(' ')).toContain('constructed-response');
    expect(inbox.find((item) => item.reason === 'skill-lab-gap')?.weaknessSignals?.[0]?.impact).toBeGreaterThan(0);
    expect(analytics.constructedResponseWeaknesses?.some((row) => row.criterion === 'apply' && row.impact > 0)).toBe(true);
    expect(analytics.objectiveImpacts?.some((row) => row.objectiveId === 'level3-portfolio-risk' && row.impact > 0)).toBe(true);
    expect(plan.nextActions.some((action) => action.reasonDetails && action.reasonDetails.length > 0)).toBe(true);
  });

  it('creates distinct artifact notes and links them back to result artifacts', async () => {
    const first = await saveResultArtifact({
      type: 'calculator',
      domain: 'cfa',
      level: 'level1',
      topic: 'quant-methods',
      title: 'TVM result',
      summary: 'Future value output.',
      assumptions: {},
      metrics: { futureValue: 110 },
      path: '/calculators',
      objectiveIds: ['calculator:tvm'],
    });
    const second = await saveResultArtifact({
      type: 'calculator',
      domain: 'cfa',
      level: 'level1',
      topic: 'fixed-income',
      title: 'Bond result',
      summary: 'Bond price output.',
      assumptions: {},
      metrics: { price: 99 },
      path: '/calculators',
      objectiveIds: ['calculator:bond'],
    });

    await saveNote({ type: 'artifact', domain: 'cfa', title: first.title, body: first.summary, path: first.path, artifactId: first.id });
    await saveNote({ type: 'artifact', domain: 'cfa', title: second.title, body: second.summary, path: second.path, artifactId: second.id });
    const exported = await exportVaultData();

    expect(exported.stores.notes.filter((note) => note.type === 'artifact')).toHaveLength(2);
    expect(exported.stores.resultArtifacts.find((artifact) => artifact.id === first.id)?.noteId).toContain(first.id);
    expect(exported.stores.resultArtifacts.find((artifact) => artifact.id === second.id)?.noteId).toContain(second.id);
  });
});
