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
} from '../domains/cfa/contentPacks';
import {
  generateContentReleaseReport,
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
  validateObjectiveMappings,
  validateSkillLabMappings,
  validateStudyUnitCoverage,
} from './curriculumValidation';

describe('CFA curriculum mapping', () => {
  it('ships a 2026 all-level map with the full Level I saturation batch structurally validated', () => {
    const fixedIncome = getCurriculumTopic('level1', 'fixed-income');
    const fsa = getCurriculumTopic('level1', 'fsa');
    expect(cfaCurriculumMap.examYear).toBe(DEFAULT_CFA_EXAM_YEAR);
    expect(cfaCurriculumMap.levels.map((level) => level.id)).toEqual(['level1', 'level2', 'level3']);
    expect(fixedIncome?.maturity).toBe('validated');
    expect(fsa?.maturity).toBe('validated');
    expect(getCurriculumLevel('level1').topics.every((topic) => topic.maturity === 'validated')).toBe(true);
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

  it('validates the full authored Level I saturation batch', () => {
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
    expect(fsaLevel1ContentPack.provenance.generatedFromTemplate).toBe(true);
    expect(fsaLevel1ContentPack.authoredQuestions.every((question) => question.provenance)).toBe(true);
    expect(fsaLevel1ContentPack.authoredVignettes.every((vignette) => vignette.provenance)).toBe(true);
    expect(fsaLevel1ContentPack.authoredFlashcards.every((card) => card.provenance)).toBe(true);
    expect(validateContentPack(fsaLevel1ContentPack).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateAuthoredContentPack(fsaLevel1ContentPack).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateContentBatch(cfaContentBatches[0]).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateLevel1SaturationBatch().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(progress.examReadyTopics).toBe(0);
    expect(progress.validatedTopics).toBe(10);
    expect(progress.releaseBlocked).toBe(false);
    expect(release.status).toBe('validated');
    expect(release.warnings).toBeGreaterThanOrEqual(10);
    expect(promotedToExamReady.promoted).toBe(false);
    expect(promotedToExamReady.issues.some((issue) => issue.area === 'editorial-provenance')).toBe(true);
    expect(promotedToValidated.promoted).toBe(true);
    expect(promotedToValidated.topic?.maturity).toBe('validated');
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
    expect(report.totals.examReadyTopics).toBe(0);
    expect(report.totals.errors).toBe(0);
    expect(allObjectiveText.toLowerCase()).not.toContain('candidate should be able to');
    expect(cfaCurriculumMap.sourceMeta.publicReferences.every((reference) => reference.url.startsWith('https://www.cfainstitute.org/'))).toBe(true);
  });
});
