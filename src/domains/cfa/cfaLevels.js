import {
  buildRuntimeLevelFromPacks,
  getLevel1RuntimeStatus,
  getLevel2RuntimeStatus,
  getLevel3RuntimeStatus,
} from './contentPacks';

function topicKey(level, topic) {
  return level === 'level1' ? topic : `${level}:${topic}`;
}

// The runtime always serves authored content packs for every level. There is no
// generated scaffold and no maturity fork — content is just content.
export const cfaLevelContent = [
  buildRuntimeLevelFromPacks('level1'),
  buildRuntimeLevelFromPacks('level2'),
  buildRuntimeLevelFromPacks('level3'),
];

export const cfaLevels = cfaLevelContent.map((level) => ({
  id: level.id,
  title: level.title,
  examFormat: level.examFormat,
  summary: level.summary,
  runtimeMode: level.runtimeMode || 'exam-ready',
  runtimeLabel: level.runtimeLabel || 'Editorial exam-ready',
  topics: level.topics.map((topic) => ({
    id: topic.id,
    label: topic.title,
    weight: topic.weight,
    maturity: topic.maturity,
    runtimeMode: topic.runtimeMode || level.runtimeMode || 'exam-ready',
    runtimeLabel: topic.runtimeLabel || level.runtimeLabel || 'Editorial exam-ready',
    questions: topic.questions.length,
    vignettes: topic.vignettes.length,
    flashcards: topic.flashcards.length,
    skillLabs: topic.skillLabs.length,
  })),
}));

export const cfaRuntimeReport = {
  generatedAt: new Date().toISOString(),
  levels: [getLevel1RuntimeStatus(), getLevel2RuntimeStatus(), getLevel3RuntimeStatus()],
};

export function getCfaRuntimeReport() {
  return cfaRuntimeReport;
}

export const cfaAllTopics = cfaLevelContent.flatMap((level) => level.topics);
export const cfaAllQuestions = cfaAllTopics.flatMap((topic) => [
  ...topic.questions,
  ...topic.vignettes.flatMap((vignette) => vignette.questions),
]);
export const cfaAllVignettes = cfaAllTopics.flatMap((topic) => topic.vignettes);
export const cfaAllFlashcards = cfaAllTopics.flatMap((topic) => topic.flashcards);
export const cfaAllSkillLabs = cfaAllTopics.flatMap((topic) => topic.skillLabs);
export const cfaAllConstructedResponses = cfaAllTopics.flatMap((topic) => topic.constructedResponses);

export function getCfaLevelContent(level = 'level1') {
  return cfaLevelContent.find((item) => item.id === level) || cfaLevelContent[0];
}

export function getCfaTopicContent(level = 'level1', topicId) {
  return getCfaLevelContent(level).topics.find((topic) => topic.id === topicId) || null;
}

export function getCfaQuestions({ level = 'level1', topic } = {}) {
  if (topic) return getCfaTopicContent(level, topic)?.questions || [];
  return getCfaLevelContent(level).topics.flatMap((item) => item.questions);
}

export function getCfaVignettes({ level = 'level1', topic } = {}) {
  if (topic) return getCfaTopicContent(level, topic)?.vignettes || [];
  return getCfaLevelContent(level).topics.flatMap((item) => item.vignettes);
}

export function getCfaConstructedResponses({ level = 'level3', topic } = {}) {
  if (topic) return getCfaTopicContent(level, topic)?.constructedResponses || [];
  return getCfaLevelContent(level).topics.flatMap((item) => item.constructedResponses);
}

export function getCfaMockExam(level = 'level1', mockId) {
  const mocks = getCfaLevelContent(level).mockExams;
  return mocks.find((mock) => mock.id === mockId) || mocks[0];
}

export function getCfaTopicKey(level, topic) {
  return topicKey(level, topic);
}
