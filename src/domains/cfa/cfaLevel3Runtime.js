import { getCfaLevelContent as getRuntimeLevelContent } from './cfaLevels';

let levelContent;

export function getCfaLevelContent() {
  if (!levelContent) levelContent = getRuntimeLevelContent('level3');
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
  return {
    level: 'level3',
    mode: 'generated',
    label: 'Generated scaffold',
    releaseEligible: false,
    topicCount: getCfaLevelContent().topics.length,
    authoredPackCount: 0,
    validatedTopics: 0,
    examReadyTopics: 0,
    blockers: ['Level III remains a future-roadmap diagnostic, not an active release gate.'],
    warnings: ['Level III runtime is generated draft content.'],
  };
}
