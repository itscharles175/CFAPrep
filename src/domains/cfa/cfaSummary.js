import { getCfaLevelContent as getLevel1Content, getCfaRuntimeStatus as getLevel1RuntimeStatus } from './cfaLevel1Runtime';
import { getCfaLevelContent as getLevel2Content, getCfaRuntimeStatus as getLevel2RuntimeStatus } from './cfaLevel2Runtime';
import { getCfaLevelContent as getLevel3Content, getCfaRuntimeStatus as getLevel3RuntimeStatus } from './cfaLevel3Runtime';

function topicSummary(topic, level) {
  return {
    id: topic.id,
    label: topic.title,
    weight: topic.weight,
    maturity: topic.maturity,
    runtimeMode: topic.runtimeMode || level.runtimeMode || 'generated',
    runtimeLabel: topic.runtimeLabel || level.runtimeLabel || 'Generated scaffold',
    questions: topic.questions.length,
    vignettes: topic.vignettes.length,
    constructedResponses: topic.constructedResponses?.length || 0,
    flashcards: topic.flashcards.length,
    skillLabs: topic.skillLabs.length,
  };
}

function levelSummary(level) {
  return {
    id: level.id,
    title: level.title,
    examFormat: level.examFormat,
    summary: level.summary,
    runtimeMode: level.runtimeMode || 'generated',
    runtimeLabel: level.runtimeLabel || 'Generated scaffold',
    topics: level.topics.map((topic) => topicSummary(topic, level)),
  };
}

export const cfaLevels = [getLevel1Content(), getLevel2Content(), getLevel3Content()].map(levelSummary);

export const cfaRuntimeReport = {
  generatedAt: new Date().toISOString(),
  levels: [getLevel1RuntimeStatus(), getLevel2RuntimeStatus(), getLevel3RuntimeStatus()],
};

export function getCfaRuntimeReport() {
  return cfaRuntimeReport;
}

export function getCfaLevelSummaries(options = {}) {
  return [getLevel1Content(), getLevel2Content(), getLevel3Content(options.level3Pathway ? { pathway: options.level3Pathway } : {})].map(levelSummary);
}
