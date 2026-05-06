import { generateCoverageReport } from '../src/lib/contentValidation.ts';
import {
  generateContentReleaseReport,
  generateCurriculumCoverageReport,
  validateCurriculumMap,
  validateLevel1SaturationBatch,
  validateLevel2SaturationBatch,
} from '../src/lib/curriculumValidation.ts';

const catalog = generateCoverageReport();
const curriculum = generateCurriculumCoverageReport();
const release = generateContentReleaseReport('level1');
const level2Release = generateContentReleaseReport('level2');
const issues = [
  ...validateCurriculumMap(),
  ...validateLevel1SaturationBatch(),
  ...validateLevel2SaturationBatch(),
  ...catalog.issues.map((issue) => ({ ...issue, area: `catalog:${issue.area}` })),
];
const errors = issues.filter((issue) => issue.severity === 'error');
const warnings = issues.filter((issue) => issue.severity === 'warning');
const futureDiagnostics = warnings.filter((issue) => issue.id.startsWith('level3:'));
const activeWarnings = warnings.filter((issue) => !issue.id.startsWith('level3:'));

console.log(`Content validation: ${errors.length} errors, ${activeWarnings.length} active warnings, ${futureDiagnostics.length} future diagnostics`);
console.log(`Catalog: ${catalog.totals.topics} topics, ${catalog.totals.questions} questions, ${catalog.totals.vignettes} vignettes`);
console.log(`Curriculum: ${curriculum.totals.examReadyTopics} exam-ready topics, ${curriculum.totals.warnings} warnings`);
console.log(`Level I release: ${release.status}, ${release.blockingIssues} blockers, ${release.warnings} warnings, ${release.templateRowsRemaining} template rows remaining`);
console.log(`Level II release: ${level2Release.status}, ${level2Release.blockingIssues} blockers, ${level2Release.warnings} warnings, ${level2Release.templateRowsRemaining} template rows remaining`);

activeWarnings.slice(0, 20).forEach((issue) => {
  console.warn(`warning ${issue.area}:${issue.id} - ${issue.message}`);
});
futureDiagnostics.slice(0, 20).forEach((issue) => {
  console.log(`future diagnostic ${issue.area}:${issue.id} - ${issue.message}`);
});

if (errors.length) {
  errors.forEach((issue) => {
    console.error(`error ${issue.area}:${issue.id} - ${issue.message}`);
  });
  process.exitCode = 1;
}
