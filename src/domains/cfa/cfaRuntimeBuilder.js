function topicKey(level, topicId) {
  return level === 'level1' ? topicId : `${level}:${topicId}`;
}

function runtimeLabel(mode) {
  if (mode === 'exam-ready') return 'Editorial exam-ready';
  if (mode === 'validated-beta') return 'Validated authored beta';
  return 'Generated scaffold';
}

function skillLabFromMapping(mapping, pack) {
  return {
    id: mapping.id,
    title: `${pack.title} ${mapping.toolType.replace('-', ' ')} lab`,
    domain: 'cfa',
    topic: topicKey(pack.level, pack.topicId),
    type: mapping.toolType === 'mock' || mapping.toolType === 'flashcard' ? 'formula-drill' : mapping.toolType,
    path: mapping.path,
    objectiveIds: mapping.objectiveIds,
    artifactType: mapping.toolType === 'excel-drill' ? 'excel-grid' : mapping.toolType === 'quant-lab' ? 'quant-lab' : 'calculator',
    description: mapping.reason,
  };
}

function toolMappingFromSkillLab(mapping) {
  return mapping.objectiveIds.map((objectiveId) => ({
    objectiveId,
    toolId: mapping.toolId,
    toolType: mapping.toolType,
    path: mapping.path,
    reason: mapping.reason,
  }));
}

export function runtimeStatusForPacks(level, packs, expectedTopicIds) {
  const packIds = new Set(packs.map((pack) => pack.topicId));
  const missingTopics = expectedTopicIds.filter((topicId) => !packIds.has(topicId));
  const complete = expectedTopicIds.length > 0 && missingTopics.length === 0 && packs.every((pack) => pack.maturity === 'exam-ready');
  const validated = expectedTopicIds.length > 0 && missingTopics.length === 0 && packs.every((pack) => pack.maturity === 'validated' || pack.maturity === 'exam-ready');
  const mode = complete ? 'exam-ready' : validated ? 'validated-beta' : 'generated';
  return {
    level,
    mode,
    label: runtimeLabel(mode),
    releaseEligible: mode === 'exam-ready',
    topicCount: expectedTopicIds.length,
    authoredPackCount: packs.length,
    validatedTopics: packs.filter((pack) => pack.maturity === 'validated').length,
    examReadyTopics: packs.filter((pack) => pack.maturity === 'exam-ready').length,
    blockers:
      mode === 'exam-ready'
        ? []
        : [
            missingTopics.length
              ? `${missingTopics.length} ${level.replace('level', 'Level ')} topic packs are missing.`
              : `${level.replace('level', 'Level ')} authored runtime is beta because packs are structurally validated but not editorial exam-ready.`,
          ],
    warnings:
      mode === 'validated-beta'
        ? ['Validated beta content is usable locally, but public release remains blocked by editorial provenance gates.']
        : [],
  };
}

export function buildRuntimeTopicFromAuthoredPack(pack, runtimeMode = 'exam-ready') {
  const formulas = pack.formulaBlueprints.map((formula) => ({
    name: formula.name,
    latex: formula.latex,
    description: formula.description,
  }));
  const formulasById = new Map(pack.formulaBlueprints.map((formula) => [formula.id, formulas.find((item) => item.name === formula.name)]));
  const readings = pack.authoredLessons.map((lesson) => ({
    id: `${lesson.id}-reading`,
    topic: topicKey(pack.level, pack.topicId),
    title: lesson.title,
    sections: lesson.sections,
    formulas: lesson.formulaIds.map((formulaId) => formulasById.get(formulaId)).filter(Boolean),
    examples: lesson.examples,
  }));
  const skillLabs = pack.skillLabMappings.map((mapping) => skillLabFromMapping(mapping, pack));

  return {
    id: pack.topicId,
    level: pack.level,
    topic: topicKey(pack.level, pack.topicId),
    title: pack.title,
    weight: pack.examWeight,
    maturity: pack.maturity,
    readings,
    sections: pack.authoredLessons.flatMap((lesson) => lesson.sections),
    examples: pack.authoredExamples,
    learningObjectives: pack.objectiveBlueprints.map((objective) => ({
      id: objective.id,
      domain: 'cfa',
      topic: topicKey(pack.level, pack.topicId),
      title: objective.title,
      description: objective.description,
      weight: 'exam-ready',
      tags: objective.tags,
    })),
    formulas,
    questions: pack.authoredQuestions,
    vignettes: pack.authoredVignettes,
    constructedResponses: pack.authoredConstructedResponses || [],
    flashcards: pack.authoredFlashcards,
    skillLabs,
    toolMappings: pack.skillLabMappings.flatMap(toolMappingFromSkillLab),
    sourceMeta: {
      original: true,
      curriculumMap: `${pack.level}:${pack.topicId}`,
      authoringStatus: pack.maturity,
      runtimeMode,
      runtimeLabel: runtimeLabel(runtimeMode),
    },
    runtimeMode,
    runtimeLabel: runtimeLabel(runtimeMode),
  };
}

function buildAuthoredMocks(level, topics) {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${level}-mixed-mock-${index + 1}`,
    level,
    title: `${level.replace('level', 'Level ')} Authored Mixed Mock ${index + 1}`,
    durationMinutes: 132,
    topics: topics.map((topic) => topic.id),
    questionIds: topics.flatMap((topic) => topic.questions.slice(index * 2, index * 2 + 2).map((question) => question.id)),
    vignetteIds: topics.flatMap((topic) => topic.vignettes.slice(index, index + 2).map((vignette) => vignette.id)),
    constructedResponseIds:
      level === 'level3'
        ? topics.flatMap((topic) => topic.constructedResponses.slice(index % 3, (index % 3) + 1).map((item) => item.id))
        : [],
    itemTypes: level === 'level2' ? ['vignette'] : ['constructed-response', 'vignette'],
  }));
}

export function buildRuntimeLevelFromAuthoredPacks(level, packs, runtimeMode = 'exam-ready') {
  const topics = packs.map((pack) => buildRuntimeTopicFromAuthoredPack(pack, runtimeMode));
  return {
    id: level,
    title: level === 'level1' ? 'CFA Level I' : level === 'level2' ? 'CFA Level II' : 'CFA Level III',
    examFormat:
      level === 'level3'
        ? 'Constructed-response and item-set mastery from authored local topic packs.'
        : level === 'level2'
          ? 'Item-set vignette mastery from authored local topic packs.'
          : 'Standalone multiple-choice mastery from authored local topic packs.',
    summary:
      runtimeMode === 'exam-ready'
        ? 'Editorial-authored local topic packs with exam-ready provenance and release gates.'
        : 'Validated beta authored runtime generated from topic-owned content packs.',
    topics,
    mockExams: buildAuthoredMocks(level, topics),
    constructedResponses: topics.flatMap((topic) => topic.constructedResponses),
    sourceMeta: {
      original: true,
      curriculumMap: level,
      authoringStatus: packs.every((pack) => pack.maturity === 'exam-ready') ? 'exam-ready' : 'draft',
      runtimeMode,
      runtimeLabel: runtimeLabel(runtimeMode),
    },
    runtimeMode,
    runtimeLabel: runtimeLabel(runtimeMode),
  };
}
