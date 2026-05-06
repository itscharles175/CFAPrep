import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CFA_EXAM_YEAR,
  cfaCurriculumMap,
  getCurriculumLevel,
  getCurriculumTopic,
} from '../domains/cfa/curriculumMap';
import {
  cfaContentBatches,
  fsaLevel1ContentPack,
  level1AuthoredContentPacks,
  level1ValidatedContentPacks,
  level2AuthoredContentPacks,
} from '../domains/cfa/contentPacks';
import {
  generateContentReleaseReport,
  generateContentReleaseReportForPacks,
  generateCurriculumCoverageReport,
  getAuthoredContentPackCounts,
  getContentPackCounts,
  getCurriculumTopicCounts,
  getLevel1BatchProgress,
  promoteTopicMaturity,
  validateAssessmentBlueprints,
  validateAuthoredContentPack,
  validateContentBatch,
  validateContentPack,
  validateCurriculumMap,
  validateLevel1SaturationBatch,
  validateLevel2SaturationBatch,
  validateObjectiveMappings,
  validateSkillLabMappings,
  validateStudyUnitCoverage,
} from './curriculumValidation';

describe('CFA curriculum mapping', () => {
  it('ships a 2026 all-level map with the full Level I saturation batch editorial exam-ready', () => {
    const fixedIncome = getCurriculumTopic('level1', 'fixed-income');
    const fsa = getCurriculumTopic('level1', 'fsa');
    expect(cfaCurriculumMap.examYear).toBe(DEFAULT_CFA_EXAM_YEAR);
    expect(cfaCurriculumMap.levels.map((level) => level.id)).toEqual(['level1', 'level2', 'level3']);
    expect(fixedIncome?.maturity).toBe('exam-ready');
    expect(fsa?.maturity).toBe('exam-ready');
    expect(getCurriculumLevel('level1').topics.every((topic) => topic.maturity === 'exam-ready')).toBe(true);
    expect(getCurriculumLevel('level3').topics.some((topic) => topic.pathway === 'portfolio-management')).toBe(true);
  });

  it('meets the Fixed Income saturation depth targets through the authored pack adapter', () => {
    const fixedIncome = getCurriculumTopic('level1', 'fixed-income');
    expect(fixedIncome).toBeTruthy();

    const counts = getCurriculumTopicCounts(fixedIncome!);
    expect(counts.studyUnits).toBe(8);
    expect(counts.lessonSections).toBeGreaterThanOrEqual(16);
    expect(counts.objectives).toBe(12);
    expect(counts.formulas).toBeGreaterThanOrEqual(10);
    expect(counts.standaloneQuestions).toBeGreaterThanOrEqual(100);
    expect(counts.vignettes).toBeGreaterThanOrEqual(8);
    expect(counts.flashcards).toBeGreaterThanOrEqual(100);
    expect(counts.skillLabs).toBeGreaterThanOrEqual(1);
    expect(fixedIncome!.studyUnits.every((unit) => unit.objectiveIds.length >= 3 && unit.objectiveIds.length <= 6)).toBe(true);
  });

  it('validates the full authored Level I saturation batch as public exam-ready', () => {
    const counts = getContentPackCounts(fsaLevel1ContentPack);
    const authoredCounts = getAuthoredContentPackCounts(fsaLevel1ContentPack);
    const promotedToExamReady = promoteTopicMaturity('level1', 'fsa');
    const promotedToValidated = promoteTopicMaturity('level1', 'fsa', 'validated');
    const progress = getLevel1BatchProgress();
    const release = generateContentReleaseReport('level1');

    expect(cfaContentBatches[0].topicIds).toEqual(['ethics', 'quant-methods', 'economics', 'fsa', 'corporate', 'equity', 'fixed-income', 'derivatives', 'alternatives', 'portfolio']);
    expect(level1AuthoredContentPacks).toHaveLength(10);
    expect(counts.lessons).toBe(8);
    expect(counts.lessonSections).toBeGreaterThanOrEqual(16);
    expect(counts.objectives).toBe(12);
    expect(counts.formulas).toBeGreaterThanOrEqual(10);
    expect(counts.standaloneQuestions).toBeGreaterThanOrEqual(100);
    expect(counts.vignettes).toBeGreaterThanOrEqual(8);
    expect(counts.flashcards).toBeGreaterThanOrEqual(100);
    expect(authoredCounts.authoredQuestions).toBeGreaterThanOrEqual(100);
    expect(authoredCounts.authoredVignettes).toBeGreaterThanOrEqual(8);
    expect(authoredCounts.authoredFlashcards).toBeGreaterThanOrEqual(100);
    expect(fsaLevel1ContentPack.provenance.generatedFromTemplate).toBe(false);
    expect(fsaLevel1ContentPack.authoredQuestions.every((question) => question.provenance?.promotionEvidence?.length)).toBe(true);
    expect(fsaLevel1ContentPack.authoredVignettes.every((vignette) => vignette.provenance?.promotionEvidence?.length)).toBe(true);
    expect(fsaLevel1ContentPack.authoredFlashcards.every((card) => card.provenance?.promotionEvidence?.length)).toBe(true);
    expect(validateContentPack(fsaLevel1ContentPack).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateAuthoredContentPack(fsaLevel1ContentPack).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateContentBatch(cfaContentBatches[0]).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateLevel1SaturationBatch().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateLevel1SaturationBatch().filter((issue) => issue.severity === 'warning')).toEqual([]);
    expect(progress.examReadyTopics).toBe(10);
    expect(progress.validatedTopics).toBe(0);
    expect(progress.releaseBlocked).toBe(false);
    expect(release.status).toBe('exam-ready');
    expect(release.templateRowsRemaining).toBe(0);
    expect(release.topics.every((topic) => topic.editorialRows === topic.totalRows && topic.missingEvidence === 0)).toBe(true);
    expect(promotedToExamReady.promoted).toBe(true);
    expect(promotedToExamReady.topic?.maturity).toBe('exam-ready');
    expect(promotedToValidated.promoted).toBe(true);
    expect(promotedToValidated.topic?.maturity).toBe('validated');
  });

  it('rejects template rows, metadata-only overrides, and missing promotion evidence', () => {
    const rawFsa = level1ValidatedContentPacks.find((pack) => pack.topicId === 'fsa')!;
    const fixedIncome = level1AuthoredContentPacks.find((pack) => pack.topicId === 'fixed-income')!;
    const templatePromoted = {
      ...rawFsa,
      maturity: 'exam-ready' as const,
      sourceMeta: { ...rawFsa.sourceMeta, authoringStatus: 'exam-ready' as const },
      authoringReview: { ...rawFsa.authoringReview, status: 'exam-ready' as const },
    };
    const metadataOnlyOverride = {
      ...templatePromoted,
      provenance: {
        ...templatePromoted.provenance,
        author: 'QuantVault editorial desk',
        reviewer: 'QuantVault metadata reviewer',
        sourceKind: 'expert-review' as const,
        editorialStatus: 'exam-ready' as const,
        generatedFromTemplate: false,
        qualityNotes: 'Pack-level metadata was changed without replacing child rows.',
        promotionEvidence: ['metadata-only-override'],
      },
    };
    const missingEvidencePack = {
      ...fixedIncome,
      authoredFlashcards: fixedIncome.authoredFlashcards.map((card, index) =>
        index === 0 ? { ...card, provenance: { ...card.provenance, promotionEvidence: undefined } } : card,
      ),
    };

    expect(validateAuthoredContentPack(templatePromoted).some((issue) => issue.message.includes('Template-generated rows cannot be promoted'))).toBe(true);
    expect(validateAuthoredContentPack(metadataOnlyOverride).some((issue) => issue.id !== metadataOnlyOverride.id && issue.area === 'editorial-provenance')).toBe(true);
    expect(validateAuthoredContentPack(missingEvidencePack).some((issue) => issue.message.includes('promotion evidence'))).toBe(true);
    expect(promoteTopicMaturity('level1', 'fixed-income').promoted).toBe(true);
  });

  it('keeps Level I release all-or-nothing while reporting topic milestones', () => {
    [1, 5, 9].forEach((readyCount) => {
      const partialPacks = level1AuthoredContentPacks.map((pack, index) =>
        index < readyCount
          ? pack
          : {
              ...pack,
              maturity: 'validated' as const,
              sourceMeta: { ...pack.sourceMeta, authoringStatus: 'validated' as const },
              authoringReview: { ...pack.authoringReview, status: 'validated' as const },
            },
      );
      const partialRelease = generateContentReleaseReportForPacks('level1', partialPacks);

      expect(partialRelease.status).toBe('validated');
      expect(partialRelease.topics.filter((topic) => topic.status === 'exam-ready')).toHaveLength(readyCount);
    });

    expect(generateContentReleaseReportForPacks('level1', level1AuthoredContentPacks).status).toBe('exam-ready');
  });

  it('validates Level II as a strict all-or-nothing exam-ready item-set release', () => {
    const release = generateContentReleaseReport('level2');

    [1, 5, 9].forEach((readyCount) => {
      const partialPacks = level2AuthoredContentPacks.map((pack, index) =>
        index < readyCount
          ? pack
          : {
              ...pack,
              maturity: 'validated' as const,
              sourceMeta: { ...pack.sourceMeta, authoringStatus: 'validated' as const },
              authoringReview: { ...pack.authoringReview, status: 'validated' as const },
            },
      );
      const partialRelease = generateContentReleaseReportForPacks('level2', partialPacks);

      expect(partialRelease.status).toBe('validated');
      expect(partialRelease.topics.filter((topic) => topic.status === 'exam-ready')).toHaveLength(readyCount);
    });

    expect(level2AuthoredContentPacks).toHaveLength(10);
    expect(validateLevel2SaturationBatch().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(release.status).toBe('exam-ready');
    expect(release.templateRowsRemaining).toBe(0);
    expect(release.topics.every((topic) => topic.editorialRows === topic.totalRows && topic.missingEvidence === 0)).toBe(true);
    expect(release.topics.every((topic) => topic.promotionEvidence.length > 0)).toBe(true);
  });

  it('validates curriculum map structure, objectives, assessments, and skill labs without release-blocking errors', () => {
    expect(validateCurriculumMap().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateStudyUnitCoverage('level1', 'fixed-income').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateStudyUnitCoverage('level1', 'fsa').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateObjectiveMappings('level1', 'fixed-income').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateObjectiveMappings('level1', 'fsa').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateAssessmentBlueprints('level1', 'fixed-income').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateAssessmentBlueprints('level1', 'fsa').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateSkillLabMappings('level1', 'fixed-income').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateSkillLabMappings('level1', 'fsa').filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('keeps level-specific assessment styles explicit', () => {
    const level1FixedIncome = getCurriculumTopic('level1', 'fixed-income');
    const level2Topics = getCurriculumLevel('level2').topics;
    const level3Topics = getCurriculumLevel('level3').topics;

    expect(
      level1FixedIncome!.studyUnits
        .flatMap((unit) => unit.assessmentBlueprints)
        .filter((assessment) => assessment.itemType === 'single')
        .every((assessment) => assessment.scope === 'standalone'),
    ).toBe(true);
    expect(
      level2Topics.every((topic) =>
        topic.studyUnits.flatMap((unit) => unit.assessmentBlueprints).some((assessment) => assessment.itemType === 'vignette' && assessment.scope === 'item-set'),
      ),
    ).toBe(true);
    expect(
      level3Topics.every((topic) =>
        topic.studyUnits
          .flatMap((unit) => unit.assessmentBlueprints)
          .some((assessment) => assessment.itemType === 'constructed-response' && assessment.commandWords?.length && assessment.rubricBands?.length),
      ),
    ).toBe(true);
  });

  it('reports curriculum coverage and source metadata without official outcome wording', () => {
    const report = generateCurriculumCoverageReport();
    const allObjectiveText = cfaCurriculumMap.levels
      .flatMap((level) => level.topics)
      .flatMap((topic) => topic.objectiveBlueprints)
      .map((objective) => `${objective.title} ${objective.description}`)
      .join(' ');

    expect(report.totals.levels).toBe(3);
    expect(report.totals.topics).toBe(26);
    expect(report.totals.examReadyTopics).toBe(20);
    expect(report.totals.errors).toBe(0);
    expect(allObjectiveText.toLowerCase()).not.toContain('candidate should be able to');
    expect(cfaCurriculumMap.sourceMeta.publicReferences.every((reference) => reference.url.startsWith('https://www.cfainstitute.org/'))).toBe(true);
  });
});
