import { buildRuntimeLevelFromAuthoredPacks, runtimeStatusForPacks } from './cfaRuntimeBuilder';
import { DEFAULT_LEVEL3_PATHWAY, normalizeLevel3Pathway } from './cfaLevel3Pathways';
import { level3AuthoredContentPacks, level3TopicIds } from './level3Packs';

let levelContent;
const pathwayContent = new Map();

export function getCfaLevelContent(options = {}) {
  if (options.pathway) return getCfaLevelContentForPathway(options.pathway);
  if (!levelContent) levelContent = buildRuntimeLevelFromAuthoredPacks('level3', level3AuthoredContentPacks, getCfaRuntimeStatus().mode);
  return levelContent;
}

export function getCfaLevelContentForPathway(pathway = DEFAULT_LEVEL3_PATHWAY) {
  const activePathway = normalizeLevel3Pathway(pathway);
  if (!pathwayContent.has(activePathway)) {
    pathwayContent.set(
      activePathway,
      buildRuntimeLevelFromAuthoredPacks('level3', level3AuthoredContentPacks, getCfaRuntimeStatus().mode, { pathway: activePathway }),
    );
  }
  return pathwayContent.get(activePathway);
}

export function getCfaTopicContent(topicId, options = {}) {
  return getCfaLevelContent(options).topics.find((topic) => topic.id === topicId) || null;
}

export function getCfaMockExam(mockId) {
  const mocks = getCfaLevelContent().mockExams;
  return mocks.find((mock) => mock.id === mockId) || mocks[0] || null;
}

export function getCfaMockExamForPathway(pathway = DEFAULT_LEVEL3_PATHWAY, mockId) {
  const mocks = getCfaLevelContentForPathway(pathway).mockExams;
  return mocks.find((mock) => mock.id === mockId) || mocks[0] || null;
}

export function getCfaRuntimeStatus() {
  return runtimeStatusForPacks('level3', level3AuthoredContentPacks, level3TopicIds);
}
