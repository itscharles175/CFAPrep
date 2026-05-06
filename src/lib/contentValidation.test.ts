import { describe, expect, it } from 'vitest';
import {
  buildCfaLevel1Course,
  buildLevel1MockExam,
  generateCoverageReport,
  validateContentCatalog,
  validateConstructedResponses,
  validateFormulaCoverage,
  validateLevelContent,
  validateMockExam,
  validateQuestionBank,
  validateSkillLabMappings,
  validateVignettes,
} from './contentValidation';

describe('content validation tooling', () => {
  it('builds a versioned CFA Level I course contract', () => {
    const course = buildCfaLevel1Course();
    expect(course.version).toBe(2);
    expect(course.levels[0].topics.length).toBe(10);
    expect(course.levels[0].topics.every((topic) => topic.learningObjectives.length >= 8)).toBe(true);
  });

  it('validates all-level catalog, question bank, formula, vignette, and lab coverage', () => {
    expect(validateContentCatalog().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateQuestionBank().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateFormulaCoverage().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateLevelContent().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateVignettes().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateConstructedResponses().filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(validateSkillLabMappings().filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('builds and validates a mixed Level I mock exam contract', () => {
    const mock = buildLevel1MockExam();
    const issues = validateMockExam(mock);

    expect(mock.id).toBe('level1-mixed-mock-1');
    expect(mock.questionIds.length).toBeGreaterThan(10);
    expect(mock.topics.length).toBeGreaterThanOrEqual(5);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('generates an editorial coverage report', () => {
    const report = generateCoverageReport();
    expect(report.totals.levels).toBe(3);
    expect(report.totals.topics).toBe(28);
    expect(report.totals.questions).toBeGreaterThanOrEqual(1000);
    expect(report.totals.vignettes).toBeGreaterThan(200);
    expect(report.totals.skillLabs).toBeGreaterThan(100);
    expect(report.totals.errors).toBe(0);
    expect(report.topics.every((topic) => topic.readinessCoverage > 0)).toBe(true);
  });

  it('credits item-set questions and constructed responses in readiness coverage', () => {
    const level2 = generateCoverageReport('level2');
    const level3 = generateCoverageReport('level3');

    expect(level2.topics.every((topic) => topic.questions === 0 && topic.vignettes >= 12)).toBe(true);
    expect(level2.topics.every((topic) => topic.readinessCoverage === 100)).toBe(true);
    expect(level3.topics.every((topic) => topic.questions === 0 && topic.constructedResponses === 3)).toBe(true);
    expect(level3.topics.every((topic) => topic.readinessCoverage === 100)).toBe(true);
  });
});
