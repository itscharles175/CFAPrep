import { buildRuntimeLevelFromAuthoredPacks, runtimeStatusForPacks } from './cfaRuntimeBuilder';
import { level3AuthoredContentPacks, level3TopicIds } from './level3Packs';

let levelContent;

export function getCfaLevelContent() {
  if (!levelContent) levelContent = buildRuntimeLevelFromAuthoredPacks('level3', level3AuthoredContentPacks, getCfaRuntimeStatus().mode);
  return levelContent;
}

export function getCfaTopicContent(topicId) {
  return getCfaLevelContent().topics.find((topic) => topic.id === topicId) || null;
}

export function getCfaMockExam(mockId) {
  const mocks = getCfaLevelContent().mockExams;
  return mocks.find((mock) => mock.id === mockId) || mocks[0] || null;
}

export function getCfaRuntimeStatus() {
  return runtimeStatusForPacks('level3', level3AuthoredContentPacks, level3TopicIds);
}
