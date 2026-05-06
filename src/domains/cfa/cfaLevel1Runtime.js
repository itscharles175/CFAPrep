import {
  buildRuntimeLevelFromPacks,
  getLevel1RuntimeStatus,
} from './contentPacks';

let levelContent;

export function getCfaLevelContent() {
  if (!levelContent) levelContent = buildRuntimeLevelFromPacks('level1');
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
  return getLevel1RuntimeStatus();
}
