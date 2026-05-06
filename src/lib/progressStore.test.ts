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
  getProgressSummary,
  getResultArtifacts,
  getReviewInbox,
  getStudyPlan,
  getStudyPlanSettings,
  importVaultData,
  migrateVaultData,
  previewVaultImport,
  recordFlashcardResult,
  recordConstructedResponseAttempt,
  recordFormulaDrillAttempt,
  recordMockAttempt,
  recordQuizAttempt,
  recordSkillLabAttempt,
  recordStudyEvent,
  recordVignetteAttempt,
  rebuildLearningIndexes,
  resetVaultData,
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
    expect(exported.checksum).toMatch(/^fnv1a32:/);
    expect(exported.stores.reviewItems[0].fsrsDifficulty).toBeTypeOf('number');
    expect(validateVaultData(exported)).toEqual({ valid: true, errors: [] });

    await resetVaultData('full');
    expect((await getProgressSummary()).questionsAnswered).toBe(0);

    await importVaultData(exported, 'replace');
    expect((await getProgressSummary()).questionsAnswered).toBe(1);
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
    expect(readiness[0].topic).toBe('fixed-income');
    expect(plan.dailyTargetMinutes).toBe(60);
    expect(plan.nextActions.length).toBeGreaterThan(0);
    expect(forecast).toHaveLength(7);
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
    expect(migrated.checksum).toMatch(/^fnv1a32:/);
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
    expect(previewVaultImport(oldExport).valid).toBe(true);
  });

  it('rejects invalid import payloads', () => {
    const validation = validateVaultData({ app: 'Other', stores: {} });
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
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

    const settings = await getStudyPlanSettings();
    const plan = await getStudyPlan();
    const summary = await getProgressSummary();

    expect(settings.dailyTargetMinutes).toBe(90);
    expect(settings.restDays).toEqual([0, 6]);
    expect(plan.examDate).toBe('2026-11-15');
    expect(plan.dailyTargetMinutes).toBe(90);
    expect(summary.studyTimeSeconds).toBe(1800);
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
    const csv = await exportArtifactCsv('quant-lab');
    const plan = await getExamPlan();

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
    expect(csv).toContain('Risk Budget Lab');
    expect(exportMockSummary(exported.stores.constructedResponseAttempts[0])).toContain('Portfolio Construction Response');
    expect(plan.targetLevel).toBe('level1');
    expect(await rebuildLearningIndexes()).toMatchObject({ reviewItems: expect.any(Number) });
  });
});
