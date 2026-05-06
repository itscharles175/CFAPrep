import { generateCoverageReport } from '../src/lib/contentValidation.ts';
import { getCfaLevelContent as getLevel1Content } from '../src/domains/cfa/cfaLevel1Runtime.js';
import { getCfaLevelContent as getLevel2Content } from '../src/domains/cfa/cfaLevel2Runtime.js';
import { getCfaLevelContent as getLevel3Content } from '../src/domains/cfa/cfaLevel3Runtime.js';
import { isGenericCfaFormulaText } from '../src/domains/cfa/formulaLexicon.js';
import { buildFormulaLibrary } from '../src/lib/formulaLibrary.js';
import { quantContent } from '../src/data/quantContent.js';
import { excelContent } from '../src/data/excelContent.js';

const level3Pathways = ['portfolio-management', 'private-markets', 'private-wealth'];

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function levelQuality(levelContent) {
  const formulas = levelContent.topics.flatMap((topic) => topic.formulas);
  const vignetteQuestions = levelContent.topics.reduce(
    (sum, topic) => sum + topic.vignettes.reduce((questionSum, vignette) => questionSum + vignette.questions.length, 0),
    0,
  );
  return {
    level: levelContent.id,
    topics: levelContent.topics.length,
    objectives: levelContent.topics.reduce((sum, topic) => sum + topic.learningObjectives.length, 0),
    formulas: formulas.length,
    genericFormulas: formulas.filter((formula) => isGenericCfaFormulaText(formula.latex)).length,
    questions: levelContent.topics.reduce((sum, topic) => sum + topic.questions.length, 0),
    vignetteQuestions,
    constructedResponses: levelContent.topics.reduce((sum, topic) => sum + topic.constructedResponses.length, 0),
    skillLabs: levelContent.topics.reduce((sum, topic) => sum + topic.skillLabs.length, 0),
  };
}

function moduleDepth(modules) {
  return Object.entries(modules).map(([id, module]) => ({
    id,
    sections: module.sections?.length || 0,
    outcomes: module.outcomes?.length || 0,
    formulas: module.formulas?.length || 0,
    hasLab: Boolean(module.lab || module.exercise),
  }));
}

function depthScore(rows) {
  const total = rows.reduce((sum, row) => {
    const sections = Math.min(1, row.sections / 3) * 0.35;
    const outcomes = Math.min(1, row.outcomes / 4) * 0.2;
    const formulas = Math.min(1, row.formulas / 3) * 0.25;
    const lab = row.hasLab ? 0.2 : 0;
    return sum + sections + outcomes + formulas + lab;
  }, 0);
  return rows.length ? total / rows.length : 0;
}

const reports = [generateCoverageReport('level1'), generateCoverageReport('level2'), generateCoverageReport('level3')];
const cfaLevels = [getLevel1Content(), getLevel2Content(), getLevel3Content({ pathway: 'portfolio-management' })].map(levelQuality);
const formulaLibrary = buildFormulaLibrary({ level3Pathway: 'portfolio-management' });
const quantRows = moduleDepth(quantContent);
const excelRows = moduleDepth(excelContent);
const pathwaySummaries = level3Pathways.map((pathway) => levelQuality(getLevel3Content({ pathway })));
const hardFailures = [
  ...reports.flatMap((report) => report.topics.filter((topic) => topic.readinessCoverage < 100).map((topic) => `${topic.level}:${topic.id} readiness ${topic.readinessCoverage}`)),
  ...cfaLevels.flatMap((level) => (level.genericFormulas ? [`${level.level} has ${level.genericFormulas} generic formulas`] : [])),
  formulaLibrary.length < 250 ? `Formula library has ${formulaLibrary.length} formulas; target is 250+` : null,
].filter(Boolean);

const advisoryGaps = [
  ...quantRows.filter((row) => row.sections < 3).map((row) => `quant:${row.id} has ${row.sections} lesson sections; target is 3+`),
  ...excelRows.filter((row) => row.sections < 3).map((row) => `excel:${row.id} has ${row.sections} lesson sections; target is 3+`),
  ...excelRows.filter((row) => row.formulas < 3).map((row) => `excel:${row.id} has ${row.formulas} formulas; target is 3+`),
];

console.log('Content quality report');
console.log(`CFA readiness: ${reports.map((report) => `${report.level}:${percent(report.topics.filter((topic) => topic.readinessCoverage === 100).length / report.topics.length)}`).join(', ')}`);
console.log(`CFA formulas: ${cfaLevels.map((level) => `${level.level}:${level.formulas}`).join(', ')}`);
console.log(`Formula library: ${formulaLibrary.length} formulas`);
console.log(`Level III pathway quality: ${pathwaySummaries.map((level, index) => `${level3Pathways[index]}:${level.topics} topics/${level.constructedResponses} CR`).join(', ')}`);
console.log(`Quant depth score: ${percent(depthScore(quantRows))}`);
console.log(`Excel depth score: ${percent(depthScore(excelRows))}`);

if (advisoryGaps.length) {
  console.log('Advisory gaps:');
  advisoryGaps.forEach((gap) => console.log(`- ${gap}`));
}

if (hardFailures.length) {
  console.error('Content quality hard failures:');
  hardFailures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
}
