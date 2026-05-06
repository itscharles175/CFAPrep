import { mkdir, writeFile } from 'node:fs/promises';
import { generateCoverageReport } from '../src/lib/contentValidation.ts';
import {
  generateContentReleaseReport,
  generateCurriculumCoverageReport,
  getLevel1BatchProgress,
} from '../src/lib/curriculumValidation.ts';
import { getCfaRuntimeReport } from '../src/domains/cfa/cfaLevels.js';

const report = {
  generatedAt: new Date().toISOString(),
  catalog: generateCoverageReport(),
  curriculum: generateCurriculumCoverageReport(),
  level1Batch: getLevel1BatchProgress(),
  level1Release: generateContentReleaseReport('level1'),
  level2Release: generateContentReleaseReport('level2'),
  runtime: getCfaRuntimeReport(),
};

await mkdir('dist/reports', { recursive: true });
await writeFile('dist/reports/content-report.json', `${JSON.stringify(report, null, 2)}\n`);

console.log('Wrote dist/reports/content-report.json');
console.log(`Level I release: ${report.level1Release.status} (${report.level1Release.blockingIssues} blockers, ${report.level1Release.warnings} warnings, ${report.level1Release.templateRowsRemaining} template rows remaining)`);
console.log(`Level II release: ${report.level2Release.status} (${report.level2Release.blockingIssues} blockers, ${report.level2Release.warnings} warnings, ${report.level2Release.templateRowsRemaining} template rows remaining)`);
console.log(`Catalog coverage: ${report.catalog.totals.topics} topics, ${report.catalog.totals.questions} questions, ${report.catalog.totals.vignettes} vignettes`);
