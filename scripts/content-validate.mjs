import { generateCoverageReport } from '../src/lib/contentValidation.ts';
import {
  generateContentReleaseReport,
  generateCurriculumCoverageReport,
  validateCurriculumMap,
  validateLevel1SaturationBatch,
} from '../src/lib/curriculumValidation.ts';

const catalog = generateCoverageReport();
const curriculum = generateCurriculumCoverageReport();
const release = generateContentReleaseReport('level1');
const issues = [
  ...validateCurriculumMap(),
  ...validateLevel1SaturationBatch(),
  ...catalog.issues.map((issue) => ({ ...issue, area: `catalog:${issue.area}` })),
];
const errors = issues.filter((issue) => issue.severity === 'error');
const warnings = issues.filter((issue) => issue.severity === 'warning');

console.log(`Content validation: ${errors.length} errors, ${warnings.length} warnings`);
console.log(`Catalog: ${catalog.totals.topics} topics, ${catalog.totals.questions} questions, ${catalog.totals.vignettes} vignettes`);
console.log(`Curriculum: ${curriculum.totals.examReadyTopics} exam-ready topics, ${curriculum.totals.warnings} warnings`);
console.log(`Level I release: ${release.status}, ${release.blockingIssues} blockers, ${release.warnings} warnings`);

warnings.slice(0, 20).forEach((issue) => {
  console.warn(`warning ${issue.area}:${issue.id} - ${issue.message}`);
});

if (errors.length) {
  errors.forEach((issue) => {
    console.error(`error ${issue.area}:${issue.id} - ${issue.message}`);
  });
  process.exitCode = 1;
}
