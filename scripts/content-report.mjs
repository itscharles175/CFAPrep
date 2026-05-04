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
  runtime: getCfaRuntimeReport(),
};

await mkdir('dist/reports', { recursive: true });
await writeFile('dist/reports/content-report.json', `${JSON.stringify(report, null, 2)}\n`);

console.log('Wrote dist/reports/content-report.json');
console.log(`Level I release: ${report.level1Release.status} (${report.level1Release.blockingIssues} blockers, ${report.level1Release.warnings} warnings)`);
console.log(`Catalog coverage: ${report.catalog.totals.topics} topics, ${report.catalog.totals.questions} questions, ${report.catalog.totals.vignettes} vignettes`);
