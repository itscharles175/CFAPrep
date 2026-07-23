import { generateCoverageReport } from '../src/lib/contentValidation.ts';
import {
  generateContentReleaseReport,
  generateCurriculumCoverageReport,
  validateCurriculumMap,
  validateLevel1SaturationBatch,
  validateLevel2SaturationBatch,
  validateLevel3SaturationBatch,
} from '../src/lib/curriculumValidation.ts';

const catalog = generateCoverageReport();
const curriculum = generateCurriculumCoverageReport();
const release = generateContentReleaseReport('level1');
const level2Release = generateContentReleaseReport('level2');
const level3Release = generateContentReleaseReport('level3');
const issues = [
  ...validateCurriculumMap(),
  ...validateLevel1SaturationBatch(),
  ...validateLevel2SaturationBatch(),
  ...validateLevel3SaturationBatch(),
  ...catalog.issues.map((issue) => ({ ...issue, area: `catalog:${issue.area}` })),
];
const errors = issues.filter((issue) => issue.severity === 'error');
const warnings = issues.filter((issue) => issue.severity === 'warning');
const activeWarnings = warnings;

console.log(`Content validation: ${errors.length} errors, ${activeWarnings.length} active warnings, 0 future diagnostics`);
console.log(`Catalog: ${catalog.totals.topics} topics, ${catalog.totals.questions} questions, ${catalog.totals.vignettes} vignettes`);
console.log(`Curriculum: ${curriculum.totals.examReadyTopics} exam-ready topics, ${curriculum.totals.warnings} warnings`);
console.log(`Level I release: ${release.status}, ${release.blockingIssues} blockers, ${release.warnings} warnings, ${release.templateRowsRemaining} template rows remaining`);
console.log(`Level II release: ${level2Release.status}, ${level2Release.blockingIssues} blockers, ${level2Release.warnings} warnings, ${level2Release.templateRowsRemaining} template rows remaining`);
console.log(`Level III release: ${level3Release.status}, ${level3Release.blockingIssues} blockers, ${level3Release.warnings} warnings, ${level3Release.templateRowsRemaining} template rows remaining`);

activeWarnings.slice(0, 20).forEach((issue) => {
  console.warn(`warning ${issue.area}:${issue.id} - ${issue.message}`);
});

if (errors.length) {
  errors.forEach((issue) => {
    console.error(`error ${issue.area}:${issue.id} - ${issue.message}`);
  });
  process.exitCode = 1;
}

// CONTENT-3 — everything above validates coverage and structure against each
// pack's SELF-DECLARED maturity, which a generated bank can satisfy while being
// unusable. The exploitability gate measures the questions themselves, so it is
// the one check a template-derived bank cannot pass by relabelling itself.
const { runContentIntegrityGate } = await import('./check-content-integrity.mjs');
if (!runContentIntegrityGate()) {
  process.exitCode = 1;
}
