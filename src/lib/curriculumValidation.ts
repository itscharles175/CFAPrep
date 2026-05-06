import {
  cfaContentBatches,
  contentPackToCurriculumTopic,
  getAuthoredContentPacks,
  getContentPack,
  level1AuthoredContentPacks,
  level1SaturationBatch,
  level1SaturationTargets,
  level2AuthoredContentPacks,
  level2SaturationBatch,
  level3AuthoredContentPacks,
  level3SaturationBatch,
} from '../domains/cfa/contentPacks';
import {
  DEFAULT_CFA_EXAM_YEAR,
  getCurriculumMap,
  getCurriculumTopic,
} from '../domains/cfa/curriculumMap';
import type {
  CfaContentBatch,
  AuthoredContentPack,
  ContentBatchProgress,
  ContentMaturity,
  ContentPack,
  ContentPackRelease,
  ContentPackReleaseTopic,
  ContentProvenance,
  CurriculumCoverageReport,
  CurriculumLevel,
  CurriculumMap,
  CurriculumTopic,
} from './contentTypes';

export interface CurriculumValidationIssue {
  severity: 'error' | 'warning';
  area: string;
  id: string;
  message: string;
}

const examReadyTargets = {
  level1: {
    studyUnits: 8,
    lessonSections: 16,
    objectives: 12,
    maxObjectives: 12,
    formulas: 10,
    examples: 12,
    standaloneQuestions: 100,
    vignettes: 8,
    flashcards: 100,
    skillLabs: 4,
  },
  level2: {
    studyUnits: 8,
    lessonSections: 10,
    objectives: 8,
    formulas: 8,
    examples: 8,
    standaloneQuestions: 0,
    vignettes: 12,
    flashcards: 40,
    skillLabs: 1,
  },
  level3: {
    studyUnits: 8,
    lessonSections: 12,
    objectives: 8,
    formulas: 6,
    examples: 8,
    standaloneQuestions: 0,
    vignettes: 4,
    constructedResponses: 3,
    flashcards: 32,
    skillLabs: 4,
  },
} as const;

function selectedEntries(level?: string, topicId?: string) {
  const map = getCurriculumMap();
  const levels = level ? [map.levels.find((item) => item.id === level) || map.levels[0]] : map.levels;
  return levels.flatMap((levelItem) =>
    levelItem.topics
      .filter((topic) => !topicId || topic.id === topicId)
      .map((topic) => ({ level: levelItem, topic })),
  );
}

export function getCurriculumTopicCounts(topic: CurriculumTopic) {
  const assessments = topic.studyUnits.flatMap((unit) => unit.assessmentBlueprints);
  const flashcardBlueprints = topic.studyUnits.flatMap((unit) => unit.flashcardBlueprints);
  return {
    studyUnits: topic.studyUnits.length,
    lessonSections: topic.studyUnits.reduce((sum, unit) => sum + unit.lessonSectionCount, 0),
    workedExamples: topic.studyUnits.reduce((sum, unit) => sum + unit.workedExampleCount, 0),
    objectives: topic.objectiveBlueprints.length,
    formulas: topic.formulaBlueprints.length,
    standaloneQuestions: assessments
      .filter((assessment) => assessment.itemType === 'single' && assessment.scope === 'standalone')
      .reduce((sum, assessment) => sum + assessment.count, 0),
    vignettes: assessments.filter((assessment) => assessment.itemType === 'vignette').reduce((sum, assessment) => sum + assessment.count, 0),
    constructedResponses: assessments
      .filter((assessment) => assessment.itemType === 'constructed-response')
      .reduce((sum, assessment) => sum + assessment.count, 0),
    flashcards: flashcardBlueprints.reduce((sum, flashcard) => sum + flashcard.count, 0),
    skillLabs: topic.skillLabMappings.length,
  };
}

function targetIssue(
  level: CurriculumLevel,
  topic: CurriculumTopic,
  metric: keyof ReturnType<typeof getCurriculumTopicCounts>,
  actual: number,
  target: number,
): CurriculumValidationIssue | null {
  if (actual >= target) return null;
  return {
    severity: topic.maturity === 'exam-ready' ? 'error' : 'warning',
    area: 'curriculum-depth',
    id: `${level.id}:${topic.id}:${metric}`,
    message: `${topic.title} has ${actual} ${metric}; exam-ready target is ${target}.`,
  };
}

function hasOfficialOutcomeLanguage(value: string) {
  return /candidate should be able to|learning outcome statements?|official curriculum text/i.test(value);
}

function duplicateIdIssues(area: string, ids: string[]): CurriculumValidationIssue[] {
  const seen = new Set<string>();
  const issues: CurriculumValidationIssue[] = [];
  ids.forEach((id) => {
    if (seen.has(id)) {
      issues.push({ severity: 'error', area, id, message: 'Duplicate id in content pack.' });
    }
    seen.add(id);
  });
  return issues;
}

export function getContentPackCounts(pack: ContentPack) {
  return {
    lessons: pack.lessonBlueprints.length,
    lessonSections: pack.lessonBlueprints.reduce((sum, lesson) => sum + lesson.sectionTitles.length, 0),
    workedExamples: pack.lessonBlueprints.reduce((sum, lesson) => sum + lesson.workedExampleTitles.length, 0),
    objectives: pack.objectiveBlueprints.length,
    formulas: pack.formulaBlueprints.length,
    standaloneQuestions: pack.questionPacks.filter((questionPack) => questionPack.itemType === 'single').reduce((sum, questionPack) => sum + questionPack.count, 0),
    constructedResponses: pack.questionPacks.filter((questionPack) => questionPack.itemType === 'constructed-response').reduce((sum, questionPack) => sum + questionPack.count, 0),
    vignettes: pack.vignettePacks.reduce((sum, vignettePack) => sum + vignettePack.count, 0),
    flashcards: pack.flashcardPacks.reduce((sum, flashcardPack) => sum + flashcardPack.count, 0),
    skillLabs: pack.skillLabMappings.length,
  };
}

function isAuthoredContentPack(pack: ContentPack): pack is AuthoredContentPack {
  return 'authoredQuestions' in pack && 'authoredLessons' in pack && 'authoredFlashcards' in pack;
}

export function getAuthoredContentPackCounts(pack: AuthoredContentPack) {
  return {
    ...getContentPackCounts(pack),
    datasets: pack.datasets.length,
    authoredLessons: pack.authoredLessons.length,
    authoredLessonSections: pack.authoredLessons.reduce((sum, lesson) => sum + lesson.sections.length, 0),
    authoredExamples: pack.authoredExamples.length,
    authoredQuestions: pack.authoredQuestions.length,
    authoredVignettes: pack.authoredVignettes.length,
    authoredConstructedResponses: pack.authoredConstructedResponses?.length ?? 0,
    authoredFlashcards: pack.authoredFlashcards.length,
  };
}

export function validateContentPack(pack: ContentPack): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];
  const objectiveIds = new Set(pack.objectiveBlueprints.map((objective) => objective.id));
  const formulaIds = new Set(pack.formulaBlueprints.map((formula) => formula.id));
  const counts = getContentPackCounts(pack);
  const target = examReadyTargets[pack.level];

  if (!pack.sourceMeta.original) {
    issues.push({ severity: 'error', area: 'content-pack', id: pack.id, message: 'Content pack must be marked as original.' });
  }
  if (hasOfficialOutcomeLanguage(`${pack.sourceMeta.notes} ${pack.objectiveBlueprints.map((objective) => `${objective.title} ${objective.description}`).join(' ')}`)) {
    issues.push({ severity: 'error', area: 'content-pack', id: pack.id, message: 'Content pack appears to contain restricted official outcome wording.' });
  }
  if (pack.authoringReview.status !== pack.maturity) {
    issues.push({ severity: 'error', area: 'content-pack', id: pack.id, message: 'Authoring review status must match pack maturity.' });
  }
  if (pack.maturity === 'exam-ready' && pack.authoringReview.checks.length < 6) {
    issues.push({ severity: 'error', area: 'content-pack', id: pack.id, message: 'Exam-ready content packs need a complete authoring review checklist.' });
  }

  issues.push(
    ...duplicateIdIssues('content-pack', [
      pack.id,
      ...pack.objectiveBlueprints.map((objective) => objective.id),
      ...pack.lessonBlueprints.map((lesson) => lesson.id),
      ...pack.formulaBlueprints.map((formula) => formula.id),
      ...pack.questionPacks.map((questionPack) => questionPack.id),
      ...pack.vignettePacks.map((vignettePack) => vignettePack.id),
      ...pack.flashcardPacks.map((flashcardPack) => flashcardPack.id),
      ...pack.skillLabMappings.map((mapping) => mapping.id),
    ]),
  );

  const depthChecks: Array<[keyof ReturnType<typeof getContentPackCounts>, number]> = [
    ['lessons', target.studyUnits],
    ['lessonSections', target.lessonSections],
    ['objectives', target.objectives],
    ['formulas', target.formulas],
    ['standaloneQuestions', target.standaloneQuestions],
    ...('constructedResponses' in target ? ([['constructedResponses', target.constructedResponses]] as Array<[keyof ReturnType<typeof getContentPackCounts>, number]>) : []),
    ['vignettes', target.vignettes],
    ['flashcards', target.flashcards],
    ['skillLabs', target.skillLabs],
  ];
  depthChecks.forEach(([metric, minimum]) => {
    if (counts[metric] < minimum) {
      issues.push({
        severity: pack.maturity === 'exam-ready' ? 'error' : 'warning',
        area: 'content-pack-depth',
        id: `${pack.id}:${metric}`,
        message: `${pack.title} content pack has ${counts[metric]} ${metric}; target is ${minimum}.`,
      });
    }
  });
  if ('maxObjectives' in target && pack.maturity === 'exam-ready' && counts.objectives > target.maxObjectives) {
    issues.push({
      severity: 'error',
      area: 'content-pack-depth',
      id: `${pack.id}:objectives`,
      message: `${pack.title} content pack has ${counts.objectives} objectives; Level I exam-ready packs are capped at ${target.maxObjectives}.`,
    });
  }

  pack.lessonBlueprints.forEach((lesson) => {
    if (pack.maturity === 'exam-ready' && (lesson.objectiveIds.length < 3 || lesson.objectiveIds.length > 6)) {
      issues.push({ severity: 'error', area: 'content-pack-lesson', id: lesson.id, message: 'Exam-ready lessons must map to 3-6 objectives.' });
    }
    if (lesson.sectionTitles.length < 2 || lesson.workedExampleTitles.length < 1 || lesson.commonErrors.length < 2) {
      issues.push({ severity: 'error', area: 'content-pack-lesson', id: lesson.id, message: 'Exam-ready lessons need sections, examples, and common errors.' });
    }
    lesson.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'content-pack-lesson', id: lesson.id, message: `Lesson maps to unknown objective ${objectiveId}.` });
      }
    });
  });

  pack.formulaBlueprints.forEach((formula) => {
    formula.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'content-pack-formula', id: formula.id, message: `Formula maps to unknown objective ${objectiveId}.` });
      }
    });
    if (!formula.latex || !formula.description) {
      issues.push({ severity: 'error', area: 'content-pack-formula', id: formula.id, message: 'Formula needs latex and description.' });
    }
  });

  pack.questionPacks.forEach((questionPack) => {
    if (pack.maturity === 'exam-ready' && !questionPack.answerRationaleRequired) {
      issues.push({ severity: 'error', area: 'content-pack-question', id: questionPack.id, message: 'Exam-ready question packs require answer rationales.' });
    }
    questionPack.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'content-pack-question', id: questionPack.id, message: `Question pack maps to unknown objective ${objectiveId}.` });
      }
    });
  });

  pack.vignettePacks.forEach((vignettePack) => {
    if (vignettePack.questionsPerVignette < 3 || !vignettePack.exhibitTypes.length) {
      issues.push({ severity: 'error', area: 'content-pack-vignette', id: vignettePack.id, message: 'Vignette packs need exhibits and at least three questions.' });
    }
    vignettePack.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'content-pack-vignette', id: vignettePack.id, message: `Vignette pack maps to unknown objective ${objectiveId}.` });
      }
    });
  });

  pack.flashcardPacks.forEach((flashcardPack) => {
    flashcardPack.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'content-pack-flashcard', id: flashcardPack.id, message: `Flashcard pack maps to unknown objective ${objectiveId}.` });
      }
    });
  });

  pack.skillLabMappings.forEach((mapping) => {
    mapping.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'content-pack-skill-lab', id: mapping.id, message: `Skill lab maps to unknown objective ${objectiveId}.` });
      }
    });
    if (!mapping.path.startsWith('/') || !mapping.reason) {
      issues.push({ severity: 'error', area: 'content-pack-skill-lab', id: mapping.id, message: 'Skill lab mapping needs a local path and rationale.' });
    }
  });

  return issues;
}

function normalizedText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const scaffoldPhrases = [
  'template-derived',
  'topic-spec factory',
  'requires line edit',
  'requires editorial polish',
  'requires row-level editorial replacement',
  'structurally validated but not final',
  'structurally saturated and validated',
  'generated scaffold',
  'validated beta',
];

function hasScaffoldLanguage(value: string) {
  const normalized = normalizedText(value);
  return scaffoldPhrases.some((phrase) => normalized.includes(normalizedText(phrase)));
}

type ProvenanceRow = {
  id: string;
  kind: string;
  provenance?: ContentProvenance;
};

function collectAuthoredProvenanceRows(pack: AuthoredContentPack): ProvenanceRow[] {
  return [
    { id: pack.id, kind: 'pack', provenance: pack.provenance },
    ...pack.datasets.map((dataset) => ({ id: dataset.id, kind: 'dataset', provenance: dataset.provenance })),
    ...pack.authoredLessons.map((lesson) => ({ id: lesson.id, kind: 'lesson', provenance: lesson.provenance })),
    ...pack.authoredExamples.map((example) => ({ id: example.id, kind: 'example', provenance: example.provenance })),
    ...pack.authoredQuestions.map((question) => ({ id: question.id, kind: 'question', provenance: question.provenance })),
    ...pack.authoredVignettes.map((vignette) => ({ id: vignette.id, kind: 'vignette', provenance: vignette.provenance })),
    ...pack.authoredVignettes.flatMap((vignette) =>
      vignette.questions.map((question) => ({ id: question.id, kind: 'vignette-question', provenance: question.provenance })),
    ),
    ...(pack.authoredConstructedResponses || []).map((item) => ({ id: item.id, kind: 'constructed-response', provenance: item.provenance })),
    ...pack.authoredFlashcards.map((flashcard) => ({ id: flashcard.id, kind: 'flashcard', provenance: flashcard.provenance })),
  ];
}

function authoredDepthIssue(
  pack: AuthoredContentPack,
  metric: keyof ReturnType<typeof getAuthoredContentPackCounts>,
  actual: number,
  target: number,
): CurriculumValidationIssue | null {
  if (actual >= target) return null;
  return {
    severity: pack.maturity === 'exam-ready' ? 'error' : 'warning',
    area: 'authored-pack-depth',
    id: `${pack.id}:${metric}`,
    message: `${pack.title} authored pack has ${actual} ${metric}; saturation target is ${target}.`,
  };
}

function validateProvenance(
  id: string,
  provenance: ContentProvenance | undefined,
  requestedMaturity: ContentMaturity,
): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];
  if (!provenance) {
    return [{ severity: 'error', area: 'editorial-provenance', id, message: 'Authored content row is missing editorial provenance.' }];
  }
  if (!provenance.author || !provenance.reviewer || !provenance.reviewedAt || !provenance.sourceKind || !provenance.editorialStatus || !provenance.qualityNotes) {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Editorial provenance requires author, reviewer, reviewedAt, sourceKind, editorialStatus, and qualityNotes.' });
  }
  if (requestedMaturity === 'exam-ready' && provenance.editorialStatus !== 'exam-ready') {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Exam-ready rows require exam-ready editorial status.' });
  }
  if (requestedMaturity === 'exam-ready' && provenance.sourceKind === 'template-spec') {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Exam-ready rows cannot use template-spec provenance.' });
  }
  if (requestedMaturity === 'exam-ready' && !provenance.promotionEvidence?.length) {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Exam-ready rows require promotion evidence.' });
  }
  if (provenance.generatedFromTemplate && requestedMaturity === 'exam-ready') {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Template-generated rows cannot be promoted to exam-ready.' });
  }
  if (provenance.editorialStatus === 'exam-ready' && provenance.generatedFromTemplate) {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Exam-ready editorial status cannot be assigned to template-generated content.' });
  }
  if (requestedMaturity === 'exam-ready' && hasScaffoldLanguage(`${provenance.author} ${provenance.reviewer} ${provenance.qualityNotes}`)) {
    issues.push({ severity: 'error', area: 'editorial-provenance', id, message: 'Exam-ready provenance still contains scaffold or template language.' });
  }
  return issues;
}

function validateAuthoredQuestionRow(
  question: AuthoredContentPack['authoredQuestions'][number],
  {
    area,
    expectedItemType,
    objectiveIds,
    formulaNames,
  }: {
    area: string;
    expectedItemType: 'single' | 'vignette';
    objectiveIds: Set<string>;
    formulaNames: Set<string>;
  },
): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];
  if (question.itemType !== expectedItemType) {
    issues.push({ severity: 'error', area, id: question.id, message: `Level I ${expectedItemType} question rows must use itemType ${expectedItemType}.` });
  }
  if (question.options.length !== 3) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Level I authored questions must have exactly three choices.' });
  }
  if (new Set(question.options.map(normalizedText)).size !== question.options.length) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Answer choices must be unique.' });
  }
  if (question.correct < 0 || question.correct >= question.options.length) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Answer key is out of range.' });
  }
  if (!objectiveIds.has(question.learningObjective)) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Question maps to an unknown objective.' });
  }
  if (question.formula && !formulaNames.has(question.formula)) {
    issues.push({ severity: 'error', area, id: question.id, message: `Question references missing formula ${question.formula}.` });
  }
  if (!question.explanation || question.explanation.length < 90) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Question explanation is too thin for an exam-ready authored pack.' });
  }
  if (
    !question.answerRationale.correct ||
    question.answerRationale.correct.length < 50 ||
    question.answerRationale.distractors.length !== 2 ||
    question.answerRationale.distractors.some((rationale) => rationale.length < 45) ||
    !question.answerRationale.examTrap
  ) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Question needs a supported correct rationale, two distractor rationales, and an exam trap.' });
  }
  if (!question.errorCategories.length || !question.tags.length) {
    issues.push({ severity: 'error', area, id: question.id, message: 'Question needs tags and error category choices.' });
  }
  return issues;
}

function validateConstructedResponseRow(
  item: NonNullable<AuthoredContentPack['authoredConstructedResponses']>[number],
  {
    objectiveIds,
    datasetIds,
  }: {
    objectiveIds: Set<string>;
    datasetIds: Set<string>;
  },
): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];
  if (item.level !== 'level3' || !item.topic.startsWith('level3:')) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Constructed responses must use Level III runtime identifiers.' });
  }
  if (!item.commandWords.length || item.commandWords.some((word) => word.length < 4)) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Constructed responses need explicit command words.' });
  }
  const mappedObjectives = new Set([...item.learningObjectives, ...item.objectiveIds]);
  if (mappedObjectives.size < 2) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Constructed responses need at least two objective mappings.' });
  }
  mappedObjectives.forEach((objectiveId) => {
    if (!objectiveIds.has(objectiveId)) {
      issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: `Constructed response maps to unknown objective ${objectiveId}.` });
    }
  });
  item.datasetIds.forEach((datasetId) => {
    if (!datasetIds.has(datasetId)) {
      issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: `Constructed response references unknown dataset ${datasetId}.` });
    }
  });
  if (!item.prompt || item.prompt.length < 160) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Constructed-response prompt is too thin for exam-ready review.' });
  }
  if (!item.modelAnswer || item.modelAnswer.length < 220) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Constructed-response model answer needs deeper case-grounded support.' });
  }
  const criterionPoints = item.rubric.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
  if (item.rubric.maxPoints <= 0 || criterionPoints !== item.rubric.maxPoints) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Rubric criterion points must sum to maxPoints.' });
  }
  if (item.rubric.criteria.length < 3 || item.rubric.criteria.some((criterion) => !criterion.label || !criterion.description || criterion.points <= 0)) {
    issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: 'Rubric needs point-bearing criteria with labels and descriptions.' });
  }
  return issues;
}

export function validateAuthoredContentPack(pack: AuthoredContentPack): CurriculumValidationIssue[] {
  const issues = [...validateContentPack(pack)];
  const counts = getAuthoredContentPackCounts(pack);
  const target = examReadyTargets[pack.level];
  const objectiveIds = new Set(pack.objectiveBlueprints.map((objective) => objective.id));
  const formulaNames = new Set(pack.formulaBlueprints.map((formula) => formula.name));
  const lessonIds = new Set(pack.lessonBlueprints.map((lesson) => lesson.id));
  const datasetIds = new Set(pack.datasets.map((dataset) => dataset.id));

  [
    authoredDepthIssue(pack, 'authoredLessons', counts.authoredLessons, target.studyUnits),
    authoredDepthIssue(pack, 'authoredLessonSections', counts.authoredLessonSections, target.lessonSections),
    authoredDepthIssue(pack, 'authoredExamples', counts.authoredExamples, target.examples),
    authoredDepthIssue(pack, 'formulas', counts.formulas, target.formulas),
    authoredDepthIssue(pack, 'objectives', counts.objectives, target.objectives),
    authoredDepthIssue(pack, 'authoredQuestions', counts.authoredQuestions, target.standaloneQuestions),
    authoredDepthIssue(pack, 'authoredVignettes', counts.authoredVignettes, target.vignettes),
    'constructedResponses' in target
      ? authoredDepthIssue(pack, 'authoredConstructedResponses', counts.authoredConstructedResponses, target.constructedResponses)
      : null,
    authoredDepthIssue(pack, 'authoredFlashcards', counts.authoredFlashcards, target.flashcards),
    authoredDepthIssue(pack, 'skillLabs', counts.skillLabs, target.skillLabs),
    authoredDepthIssue(pack, 'datasets', counts.datasets, 1),
  ]
    .filter(Boolean)
    .forEach((issue) => issues.push(issue as CurriculumValidationIssue));

  issues.push(...validateProvenance(pack.id, pack.provenance, pack.maturity));
  if (pack.provenance.generatedFromTemplate && pack.maturity !== 'exam-ready') {
    issues.push({
      severity: 'warning',
      area: 'editorial-provenance',
      id: pack.id,
      message: 'Pack is structurally validated, but template-generated rows block public exam-ready release.',
    });
  }

  const authoredText = [
    ...pack.authoredLessons.flatMap((lesson) => [
      lesson.title,
      ...lesson.sections.map((section) => `${section.title} ${section.content}`),
      ...lesson.commonErrors,
      ...lesson.keyTakeaways,
    ]),
    ...pack.authoredExamples.flatMap((example) => [example.title, example.prompt, example.walkthrough]),
    ...pack.authoredQuestions.flatMap((question) => [question.question, question.explanation, ...question.options, question.answerRationale.correct, ...question.answerRationale.distractors]),
    ...pack.authoredVignettes.flatMap((vignette) => [vignette.title, vignette.stem, ...vignette.exhibits.map((exhibit) => `${exhibit.title} ${exhibit.content}`)]),
    ...(pack.authoredConstructedResponses || []).flatMap((item) => [
      item.title,
      item.prompt,
      item.modelAnswer,
      ...item.commandWords,
      item.rubric.title,
      ...item.rubric.criteria.flatMap((criterion) => [criterion.label, criterion.description]),
    ]),
    ...pack.authoredFlashcards.flatMap((flashcard) => [flashcard.front, flashcard.back]),
  ].join(' ');
  if (hasOfficialOutcomeLanguage(authoredText)) {
    issues.push({ severity: 'error', area: 'authored-pack-originality', id: pack.id, message: 'Authored learner-facing text appears to contain restricted official outcome wording.' });
  }
  if (pack.maturity === 'exam-ready' && hasScaffoldLanguage(authoredText)) {
    issues.push({ severity: 'error', area: 'authored-pack-originality', id: pack.id, message: 'Exam-ready authored text still contains known scaffold language.' });
  }

  issues.push(
    ...duplicateIdIssues('authored-pack', [
      ...pack.datasets.map((dataset) => dataset.id),
      ...pack.authoredLessons.map((lesson) => lesson.id),
      ...pack.authoredExamples.map((example) => example.id),
      ...pack.authoredQuestions.map((question) => question.id),
      ...pack.authoredVignettes.flatMap((vignette) => [vignette.id, ...vignette.exhibits.map((exhibit) => exhibit.id), ...vignette.questions.map((question) => question.id)]),
      ...(pack.authoredConstructedResponses || []).flatMap((item) => [item.id, item.rubric.id, ...item.rubric.criteria.map((criterion) => criterion.id)]),
      ...pack.authoredFlashcards.map((flashcard) => flashcard.id),
    ]),
  );

  pack.datasets.forEach((dataset) => {
    issues.push(...validateProvenance(dataset.id, dataset.provenance, pack.maturity));
    if (!dataset.columns.length || !dataset.rows.length) {
      issues.push({ severity: 'error', area: 'authored-dataset', id: dataset.id, message: 'Topic dataset needs columns and rows.' });
    }
    dataset.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'authored-dataset', id: dataset.id, message: `Dataset maps to unknown objective ${objectiveId}.` });
      }
    });
  });

  pack.authoredLessons.forEach((lesson) => {
    issues.push(...validateProvenance(lesson.id, lesson.provenance, pack.maturity));
    if (!lessonIds.has(lesson.id)) {
      issues.push({ severity: 'error', area: 'authored-lesson', id: lesson.id, message: 'Authored lesson has no matching lesson blueprint.' });
    }
    if (lesson.sections.length < 2 || !lesson.examples.length || lesson.commonErrors.length < 2) {
      issues.push({ severity: 'error', area: 'authored-lesson', id: lesson.id, message: 'Authored lesson needs sections, examples, and common errors.' });
    }
    lesson.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'authored-lesson', id: lesson.id, message: `Authored lesson maps to unknown objective ${objectiveId}.` });
      }
    });
  });

  pack.authoredExamples.forEach((example) => {
    issues.push(...validateProvenance(example.id, example.provenance, pack.maturity));
    if (!lessonIds.has(example.lessonId)) {
      issues.push({ severity: 'error', area: 'authored-example', id: example.id, message: 'Authored example maps to an unknown lesson.' });
    }
    if (!objectiveIds.has(example.objectiveId) || !objectiveIds.has(example.learningObjective)) {
      issues.push({ severity: 'error', area: 'authored-example', id: example.id, message: 'Authored example maps to an unknown objective.' });
    }
    if (example.datasetId && !datasetIds.has(example.datasetId)) {
      issues.push({ severity: 'error', area: 'authored-example', id: example.id, message: 'Authored example references an unknown dataset.' });
    }
  });

  const seenQuestionPrompts = new Map<string, string>();
  pack.authoredQuestions.forEach((question) => {
    issues.push(...validateProvenance(question.id, question.provenance, pack.maturity));
    const promptKey = normalizedText(question.question);
    const prior = seenQuestionPrompts.get(promptKey);
    if (prior) {
      issues.push({ severity: 'error', area: 'authored-question', id: question.id, message: `Duplicate standalone prompt also used by ${prior}.` });
    }
    seenQuestionPrompts.set(promptKey, question.id);
    issues.push(...validateAuthoredQuestionRow(question, { area: 'authored-question', expectedItemType: 'single', objectiveIds, formulaNames }));
  });

  pack.authoredVignettes.forEach((vignette) => {
    issues.push(...validateProvenance(vignette.id, vignette.provenance, pack.maturity));
    if (!vignette.exhibits.length || vignette.questions.length < 3) {
      issues.push({ severity: 'error', area: 'authored-vignette', id: vignette.id, message: 'Mini-vignettes need exhibits and at least three independently scorable questions.' });
    }
    vignette.objectiveIds.forEach((objectiveId) => {
      if (!objectiveIds.has(objectiveId)) {
        issues.push({ severity: 'error', area: 'authored-vignette', id: vignette.id, message: `Vignette maps to unknown objective ${objectiveId}.` });
      }
    });
    vignette.datasetIds.forEach((datasetId) => {
      if (!datasetIds.has(datasetId)) {
        issues.push({ severity: 'error', area: 'authored-vignette', id: vignette.id, message: `Vignette references unknown dataset ${datasetId}.` });
      }
    });
    vignette.questions.forEach((question) => {
      issues.push(...validateProvenance(question.id, question.provenance, pack.maturity));
      issues.push(...validateAuthoredQuestionRow(question, { area: 'authored-vignette', expectedItemType: 'vignette', objectiveIds, formulaNames }));
    });
    vignette.exhibits.forEach((exhibit) => {
      if (!exhibit.title || !exhibit.content || !exhibit.sourceObjectiveIds.length) {
        issues.push({ severity: 'error', area: 'authored-vignette', id: exhibit.id, message: 'Vignette exhibit needs title, content, and objective mapping.' });
      }
    });
  });

  const seenConstructedPrompts = new Map<string, string>();
  (pack.authoredConstructedResponses || []).forEach((item) => {
    issues.push(...validateProvenance(item.id, item.provenance, pack.maturity));
    const promptKey = normalizedText(item.prompt);
    const prior = seenConstructedPrompts.get(promptKey);
    if (prior) {
      issues.push({ severity: 'error', area: 'authored-constructed-response', id: item.id, message: `Duplicate constructed-response prompt also used by ${prior}.` });
    }
    seenConstructedPrompts.set(promptKey, item.id);
    issues.push(...validateConstructedResponseRow(item, { objectiveIds, datasetIds }));
  });

  pack.authoredFlashcards.forEach((flashcard) => {
    issues.push(...validateProvenance(flashcard.id, flashcard.provenance, pack.maturity));
    if (!objectiveIds.has(flashcard.objectiveId)) {
      issues.push({ severity: 'error', area: 'authored-flashcard', id: flashcard.id, message: 'Flashcard maps to an unknown objective.' });
    }
    if (!flashcard.front || !flashcard.back || !flashcard.sourcePath.startsWith('/')) {
      issues.push({ severity: 'error', area: 'authored-flashcard', id: flashcard.id, message: 'Flashcard needs front, back, and a local source path.' });
    }
  });

  return issues;
}

export function validateContentBatch(batch: CfaContentBatch): CurriculumValidationIssue[] {
  const issues = batch.packs.flatMap((pack) => (isAuthoredContentPack(pack) ? validateAuthoredContentPack(pack) : validateContentPack(pack)));
  const packTopicIds = new Set(batch.packs.map((pack) => pack.topicId));

  batch.topicIds.forEach((topicId) => {
    if (!packTopicIds.has(topicId) && topicId !== 'fixed-income') {
      issues.push({ severity: 'warning', area: 'content-batch', id: `${batch.id}:${topicId}`, message: 'Batch topic does not yet have a typed content pack.' });
    }
  });
  if (batch.maturity === 'exam-ready' && batch.packs.some((pack) => pack.maturity !== 'exam-ready')) {
    issues.push({ severity: 'error', area: 'content-batch', id: batch.id, message: 'Exam-ready batches can only contain exam-ready packs.' });
  }
  if (!batch.acceptanceCriteria.length) {
    issues.push({ severity: 'error', area: 'content-batch', id: batch.id, message: 'Batch needs acceptance criteria.' });
  }

  return issues;
}

export function validateContentBatches(): CurriculumValidationIssue[] {
  return cfaContentBatches.flatMap((batch) => validateContentBatch(batch));
}

export function validateLevel1SaturationBatch(): CurriculumValidationIssue[] {
  const issues = validateContentBatch(level1SaturationBatch);
  const expectedTopicIds = new Set(level1SaturationBatch.topicIds);
  const packTopicIds = new Set(level1AuthoredContentPacks.map((pack) => pack.topicId));

  expectedTopicIds.forEach((topicId) => {
    if (!packTopicIds.has(topicId)) {
      issues.push({ severity: 'error', area: 'level1-saturation', id: topicId, message: 'Missing authored Level I saturation pack.' });
    }
  });
  level1AuthoredContentPacks.forEach((pack) => {
    if (pack.maturity !== 'exam-ready') {
      issues.push({ severity: 'warning', area: 'level1-saturation', id: pack.id, message: 'Pack is structurally saturated but not public exam-ready.' });
    }
  });

  return issues;
}

export function validateLevel2SaturationBatch(): CurriculumValidationIssue[] {
  const issues = validateContentBatch(level2SaturationBatch);
  const expectedTopicIds = new Set(level2SaturationBatch.topicIds);
  const packTopicIds = new Set(level2AuthoredContentPacks.map((pack) => pack.topicId));

  expectedTopicIds.forEach((topicId) => {
    if (!packTopicIds.has(topicId)) {
      issues.push({ severity: 'error', area: 'level2-saturation', id: topicId, message: 'Missing authored Level II item-set pack.' });
    }
  });
  level2AuthoredContentPacks.forEach((pack) => {
    if (pack.maturity !== 'exam-ready') {
      issues.push({ severity: 'warning', area: 'level2-saturation', id: pack.id, message: 'Pack is saturated but not public Level II exam-ready.' });
    }
  });

  return issues;
}

export function validateLevel3SaturationBatch(): CurriculumValidationIssue[] {
  const issues = validateContentBatch(level3SaturationBatch);
  const expectedTopicIds = new Set(level3SaturationBatch.topicIds);
  const packTopicIds = new Set(level3AuthoredContentPacks.map((pack) => pack.topicId));

  expectedTopicIds.forEach((topicId) => {
    if (!packTopicIds.has(topicId)) {
      issues.push({ severity: 'error', area: 'level3-saturation', id: topicId, message: 'Missing authored Level III constructed-response pack.' });
    }
  });
  level3AuthoredContentPacks.forEach((pack) => {
    if (pack.maturity !== 'exam-ready') {
      issues.push({ severity: 'warning', area: 'level3-saturation', id: pack.id, message: 'Pack is saturated but not public Level III exam-ready.' });
    }
  });

  return issues;
}

export function getLevel1BatchProgress(): ContentBatchProgress {
  const packs = getAuthoredContentPacks('level1');
  const counts = packs.map(getAuthoredContentPackCounts);
  const issues = validateLevel1SaturationBatch();
  return {
    id: level1SaturationBatch.id,
    level: 'level1',
    title: level1SaturationBatch.title,
    topicCount: level1SaturationBatch.topicIds.length,
    examReadyTopics: packs.filter((pack) => pack.maturity === 'exam-ready').length,
    validatedTopics: packs.filter((pack) => pack.maturity === 'validated').length,
    draftTopics: packs.filter((pack) => pack.maturity === 'draft' || pack.maturity === 'stub').length,
    totalObjectives: counts.reduce((sum, count) => sum + count.objectives, 0),
    totalLessons: counts.reduce((sum, count) => sum + count.authoredLessons, 0),
    totalExamples: counts.reduce((sum, count) => sum + count.authoredExamples, 0),
    totalQuestions: counts.reduce((sum, count) => sum + count.authoredQuestions, 0),
    totalVignettes: counts.reduce((sum, count) => sum + count.authoredVignettes, 0),
    totalFlashcards: counts.reduce((sum, count) => sum + count.authoredFlashcards, 0),
    totalSkillLabs: counts.reduce((sum, count) => sum + count.skillLabs, 0),
    releaseBlocked: issues.some((issue) => issue.severity === 'error'),
  };
}

export function getContentBatchProgress(level: CurriculumLevel['id']): ContentBatchProgress {
  if (level === 'level1') return getLevel1BatchProgress();

  const batch = level === 'level2' ? level2SaturationBatch : level === 'level3' ? level3SaturationBatch : cfaContentBatches.find((item) => item.level === level);
  const packs = getAuthoredContentPacks(level);
  const counts = packs.map(getAuthoredContentPackCounts);
  const issues = level === 'level2' ? validateLevel2SaturationBatch() : level === 'level3' ? validateLevel3SaturationBatch() : packs.flatMap(validateAuthoredContentPack);

  return {
    id: batch?.id || `${level}-content-batch`,
    level,
    title: batch?.title || `${level} content batch`,
    topicCount: batch?.topicIds.length || packs.length,
    examReadyTopics: packs.filter((pack) => pack.maturity === 'exam-ready').length,
    validatedTopics: packs.filter((pack) => pack.maturity === 'validated').length,
    draftTopics: packs.filter((pack) => pack.maturity === 'draft' || pack.maturity === 'stub').length,
    totalObjectives: counts.reduce((sum, count) => sum + count.objectives, 0),
    totalLessons: counts.reduce((sum, count) => sum + count.authoredLessons, 0),
    totalExamples: counts.reduce((sum, count) => sum + count.authoredExamples, 0),
    totalQuestions: counts.reduce((sum, count) => sum + count.authoredQuestions, 0),
    totalVignettes: counts.reduce((sum, count) => sum + count.authoredVignettes, 0),
    totalFlashcards: counts.reduce((sum, count) => sum + count.authoredFlashcards, 0),
    totalSkillLabs: counts.reduce((sum, count) => sum + count.skillLabs, 0),
    releaseBlocked: issues.some((issue) => issue.severity === 'error'),
  };
}

export function getContentPackReleaseTopic(pack: AuthoredContentPack): ContentPackReleaseTopic {
  const issues = validateAuthoredContentPack(pack);
  const rows = collectAuthoredProvenanceRows(pack);
  const promotionEvidence = [
    ...new Set([
      ...(pack.authoringReview.promotionEvidence || []),
      ...rows.flatMap((row) => row.provenance?.promotionEvidence || []),
    ]),
  ];
  const editorialRows = rows.filter((row) => row.provenance && !row.provenance.generatedFromTemplate && row.provenance.editorialStatus === 'exam-ready').length;
  const templateRowsRemaining = rows.filter(
    (row) => !row.provenance || row.provenance.generatedFromTemplate || row.provenance.sourceKind === 'template-spec' || row.provenance.editorialStatus !== 'exam-ready',
  ).length;
  const missingEvidence = rows.filter((row) => !row.provenance?.promotionEvidence?.length).length;

  return {
    topicId: pack.topicId,
    title: pack.title,
    status: pack.maturity,
    totalRows: rows.length,
    editorialRows,
    templateRowsRemaining,
    missingEvidence,
    blockers: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    reviewer: pack.authoringReview.reviewer,
    reviewedAt: pack.authoringReview.reviewedAt,
    promotionEvidence,
  };
}

function buildContentReleaseReport(
  level: CurriculumLevel['id'],
  packs: AuthoredContentPack[],
  issues: CurriculumValidationIssue[],
): ContentPackRelease {
  const levelLabel = level === 'level1' ? 'Level I' : level === 'level2' ? 'Level II' : 'Level III';
  const topics = packs.map(getContentPackReleaseTopic);
  const blockingIssues = issues.filter((issue) => issue.severity === 'error').length;
  const expectedTopicCount =
    level === 'level1'
      ? level1SaturationBatch.topicIds.length
      : level === 'level2'
        ? level2SaturationBatch.topicIds.length
        : level === 'level3'
          ? level3SaturationBatch.topicIds.length
          : packs.length;
  const allExpectedTopicsPresent = packs.length === expectedTopicCount;
  const allTopicsExamReady =
    allExpectedTopicsPresent &&
    packs.length > 0 &&
    packs.every((pack) => pack.maturity === 'exam-ready') &&
    topics.every((topic) => topic.templateRowsRemaining === 0 && topic.missingEvidence === 0 && topic.blockers === 0);

  return {
    id: `${level}-content-release-${DEFAULT_CFA_EXAM_YEAR}`,
    level,
    status: blockingIssues ? 'draft' : allTopicsExamReady ? 'exam-ready' : 'validated',
    generatedAt: new Date().toISOString(),
    topicIds: packs.map((pack) => pack.topicId),
    packIds: packs.map((pack) => pack.id),
    topics,
    templateRowsRemaining: topics.reduce((sum, topic) => sum + topic.templateRowsRemaining, 0),
    blockingIssues,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    notes: [
      'Release report is generated locally from authored content packs.',
      `Exam-ready status requires full authored ${levelLabel} packs with row-level editorial provenance and promotion evidence.`,
      allTopicsExamReady
        ? `${levelLabel} public release gate can open because every topic pack is exam-ready.`
        : `${levelLabel} public release remains all-or-nothing until every topic pack is exam-ready.`,
    ],
  };
}

export function generateContentReleaseReportForPacks(
  level: CurriculumLevel['id'],
  packs: AuthoredContentPack[],
): ContentPackRelease {
  const issues = packs.flatMap(validateAuthoredContentPack);
  packs.forEach((pack) => {
    if (pack.maturity !== 'exam-ready') {
      issues.push({ severity: 'warning', area: `${level}-saturation`, id: pack.id, message: 'Pack is structurally saturated but not public exam-ready.' });
    }
  });
  return buildContentReleaseReport(level, packs, issues);
}

export function generateContentReleaseReport(level: CurriculumLevel['id'] = 'level1'): ContentPackRelease {
  const packs = getAuthoredContentPacks(level);
  const issues =
    level === 'level1'
      ? validateLevel1SaturationBatch()
      : level === 'level2'
        ? validateLevel2SaturationBatch()
        : level === 'level3'
          ? validateLevel3SaturationBatch()
          : packs.flatMap(validateAuthoredContentPack);
  return buildContentReleaseReport(level, packs, issues);
}

function validateSourceMeta(map: CurriculumMap): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];
  const allMeta = [
    { id: map.id, meta: map.sourceMeta },
    ...map.levels.flatMap((level) => level.topics.map((topic) => ({ id: `${level.id}:${topic.id}`, meta: topic.sourceMeta }))),
  ];

  allMeta.forEach(({ id, meta }) => {
    if (!meta.original) {
      issues.push({ severity: 'error', area: 'curriculum-source', id, message: 'Curriculum metadata must mark learner-facing content as original.' });
    }
    if (!meta.publicReferences.length) {
      issues.push({ severity: 'error', area: 'curriculum-source', id, message: 'Curriculum metadata must include public structural references.' });
    }
    if (hasOfficialOutcomeLanguage(meta.notes)) {
      issues.push({ severity: 'error', area: 'curriculum-source', id, message: 'Source notes appear to include restricted official outcome wording.' });
    }
  });

  return issues;
}

export function validateStudyUnitCoverage(level?: string, topicId?: string): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];

  selectedEntries(level, topicId).forEach(({ level: levelItem, topic }) => {
    if (!topic.studyUnits.length) {
      issues.push({ severity: 'error', area: 'study-unit', id: `${levelItem.id}:${topic.id}`, message: 'Topic has no study units.' });
    }

    topic.studyUnits.forEach((unit) => {
      const minObjectives = topic.maturity === 'exam-ready' ? 3 : 1;
      if (unit.objectiveIds.length < minObjectives || unit.objectiveIds.length > 6) {
        issues.push({
          severity: topic.maturity === 'exam-ready' ? 'error' : 'warning',
          area: 'study-unit',
          id: unit.id,
          message: `Study unit should map to ${topic.maturity === 'exam-ready' ? '3-6' : 'at least 1'} objective blueprints.`,
        });
      }
      if (unit.lessonSectionCount <= 0) {
        issues.push({ severity: 'error', area: 'study-unit', id: unit.id, message: 'Study unit needs lesson section coverage.' });
      }
      if (unit.workedExampleCount <= 0) {
        issues.push({ severity: 'warning', area: 'study-unit', id: unit.id, message: 'Study unit should include at least one worked example.' });
      }
      if (topic.maturity === 'exam-ready' && unit.commonErrors.length < 2) {
        issues.push({ severity: 'error', area: 'study-unit', id: unit.id, message: 'Exam-ready study units need at least two common error patterns.' });
      }
    });

    const counts = getCurriculumTopicCounts(topic);
    const target = examReadyTargets[levelItem.id];
    [
      targetIssue(levelItem, topic, 'studyUnits', counts.studyUnits, target.studyUnits),
      targetIssue(levelItem, topic, 'lessonSections', counts.lessonSections, target.lessonSections),
      targetIssue(levelItem, topic, 'objectives', counts.objectives, target.objectives),
      'maxObjectives' in target && topic.maturity === 'exam-ready' && counts.objectives > target.maxObjectives
        ? {
            severity: 'error' as const,
            area: 'curriculum-depth',
            id: `${levelItem.id}:${topic.id}:objectives`,
            message: `${topic.title} has ${counts.objectives} objectives; pilot target caps Level I exam-ready topics at ${target.maxObjectives}.`,
          }
        : null,
      targetIssue(levelItem, topic, 'formulas', counts.formulas, target.formulas),
      targetIssue(levelItem, topic, 'standaloneQuestions', counts.standaloneQuestions, target.standaloneQuestions),
      targetIssue(levelItem, topic, 'vignettes', counts.vignettes, target.vignettes),
      'constructedResponses' in target
        ? targetIssue(levelItem, topic, 'constructedResponses', counts.constructedResponses, target.constructedResponses)
        : null,
      targetIssue(levelItem, topic, 'flashcards', counts.flashcards, target.flashcards),
      targetIssue(levelItem, topic, 'skillLabs', counts.skillLabs, target.skillLabs),
    ]
      .filter(Boolean)
      .forEach((issue) => issues.push(issue as CurriculumValidationIssue));
  });

  return issues;
}

export function validateObjectiveMappings(level?: string, topicId?: string): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];

  selectedEntries(level, topicId).forEach(({ level: levelItem, topic }) => {
    const objectiveIds = new Set<string>();
    const formulaIds = new Set<string>();
    const unitIds = new Set<string>();

    topic.objectiveBlueprints.forEach((objective) => {
      if (objectiveIds.has(objective.id)) {
        issues.push({ severity: 'error', area: 'objective-map', id: objective.id, message: 'Duplicate objective blueprint id.' });
      }
      objectiveIds.add(objective.id);
      if (hasOfficialOutcomeLanguage(`${objective.title} ${objective.description}`)) {
        issues.push({ severity: 'error', area: 'objective-map', id: objective.id, message: 'Objective appears to use restricted official outcome wording.' });
      }
      if (!objective.title || !objective.description || !objective.tags.length) {
        issues.push({ severity: 'error', area: 'objective-map', id: objective.id, message: 'Objective blueprint needs title, description, and tags.' });
      }
      if (levelItem.id === 'level3' && !objective.commandWords?.length) {
        issues.push({ severity: 'warning', area: 'objective-map', id: objective.id, message: 'Level III objectives should include command-word cues.' });
      }
    });

    topic.formulaBlueprints.forEach((formula) => {
      if (formulaIds.has(formula.id)) {
        issues.push({ severity: 'error', area: 'formula-map', id: formula.id, message: 'Duplicate formula blueprint id.' });
      }
      formulaIds.add(formula.id);
      if (!formula.name || !formula.description || !formula.latex) {
        issues.push({ severity: 'error', area: 'formula-map', id: formula.id, message: 'Formula blueprint is incomplete.' });
      }
      formula.objectiveIds.forEach((objectiveId) => {
        if (!objectiveIds.has(objectiveId)) {
          issues.push({ severity: 'error', area: 'formula-map', id: formula.id, message: `Formula maps to unknown objective ${objectiveId}.` });
        }
      });
    });

    topic.studyUnits.forEach((unit) => {
      if (unitIds.has(unit.id)) {
        issues.push({ severity: 'error', area: 'study-unit-map', id: unit.id, message: 'Duplicate study unit id.' });
      }
      unitIds.add(unit.id);
      unit.objectiveIds.forEach((objectiveId) => {
        if (!objectiveIds.has(objectiveId)) {
          issues.push({ severity: 'error', area: 'study-unit-map', id: unit.id, message: `Study unit maps to unknown objective ${objectiveId}.` });
        }
      });
      unit.formulaIds.forEach((formulaId) => {
        if (!formulaIds.has(formulaId)) {
          issues.push({ severity: 'error', area: 'study-unit-map', id: unit.id, message: `Study unit maps to unknown formula ${formulaId}.` });
        }
      });
    });
  });

  return issues;
}

export function validateAssessmentBlueprints(level?: string, topicId?: string): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];

  selectedEntries(level, topicId).forEach(({ level: levelItem, topic }) => {
    const objectiveIds = new Set(topic.objectiveBlueprints.map((objective) => objective.id));
    const assessmentIds = new Set<string>();
    const assessments = topic.studyUnits.flatMap((unit) => unit.assessmentBlueprints);

    assessments.forEach((assessment) => {
      if (assessmentIds.has(assessment.id)) {
        issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Duplicate assessment blueprint id.' });
      }
      assessmentIds.add(assessment.id);
      if (assessment.count <= 0) {
        issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Assessment blueprint count must be positive.' });
      }
      if (!assessment.promptStyle || !assessment.notes) {
        issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Assessment blueprint needs prompt style and notes.' });
      }
      assessment.objectiveIds.forEach((objectiveId) => {
        if (!objectiveIds.has(objectiveId)) {
          issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: `Assessment maps to unknown objective ${objectiveId}.` });
        }
      });
      const difficultyTotal = Object.values(assessment.difficultyMix).reduce((sum, value) => sum + (value || 0), 0);
      if (difficultyTotal <= 0) {
        issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Assessment needs a non-empty difficulty mix.' });
      }
      if (levelItem.id === 'level1' && assessment.itemType === 'single' && assessment.scope !== 'standalone') {
        issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Level I single questions must be standalone.' });
      }
      if (levelItem.id === 'level1' && assessment.itemType === 'vignette' && assessment.scope !== 'mini-vignette') {
        issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Level I case practice must be marked as mini-vignette synthesis.' });
      }
      if (levelItem.id === 'level3' && assessment.itemType === 'constructed-response') {
        if (!assessment.commandWords?.length || !assessment.rubricBands?.length) {
          issues.push({ severity: 'error', area: 'assessment-map', id: assessment.id, message: 'Level III constructed responses need command words and rubric bands.' });
        }
      }
    });

    if (levelItem.id === 'level2' && !assessments.some((assessment) => assessment.itemType === 'vignette' && assessment.scope === 'item-set')) {
      issues.push({ severity: 'error', area: 'assessment-map', id: `${levelItem.id}:${topic.id}`, message: 'Level II topic needs vignette-first item-set blueprints.' });
    }
    if (levelItem.id === 'level3' && !assessments.some((assessment) => assessment.itemType === 'constructed-response')) {
      issues.push({ severity: 'error', area: 'assessment-map', id: `${levelItem.id}:${topic.id}`, message: 'Level III topic needs constructed-response blueprints.' });
    }
  });

  return issues;
}

export function validateSkillLabMappings(level?: string, topicId?: string): CurriculumValidationIssue[] {
  const issues: CurriculumValidationIssue[] = [];

  selectedEntries(level, topicId).forEach(({ level: levelItem, topic }) => {
    const objectiveIds = new Set(topic.objectiveBlueprints.map((objective) => objective.id));
    const mappingIds = new Set<string>();

    if (!topic.skillLabMappings.length) {
      issues.push({ severity: 'error', area: 'skill-lab-map', id: `${levelItem.id}:${topic.id}`, message: 'Topic needs at least one skill-lab mapping.' });
    }

    topic.skillLabMappings.forEach((mapping) => {
      if (mappingIds.has(mapping.id)) {
        issues.push({ severity: 'error', area: 'skill-lab-map', id: mapping.id, message: 'Duplicate skill-lab mapping id.' });
      }
      mappingIds.add(mapping.id);
      if (!mapping.path.startsWith('/') || !mapping.reason || !mapping.toolId) {
        issues.push({ severity: 'error', area: 'skill-lab-map', id: mapping.id, message: 'Skill-lab mapping needs local path, tool id, and reason.' });
      }
      mapping.objectiveIds.forEach((objectiveId) => {
        if (!objectiveIds.has(objectiveId)) {
          issues.push({ severity: 'error', area: 'skill-lab-map', id: mapping.id, message: `Skill lab maps to unknown objective ${objectiveId}.` });
        }
      });
    });
  });

  return issues;
}

export function validateCurriculumMap(examYear = DEFAULT_CFA_EXAM_YEAR): CurriculumValidationIssue[] {
  const map = getCurriculumMap(examYear);
  const issues: CurriculumValidationIssue[] = [];

  if (map.examYear !== examYear) {
    issues.push({
      severity: 'warning',
      area: 'curriculum-map',
      id: map.id,
      message: `Requested exam year ${examYear}; QuantVault currently ships ${map.examYear}.`,
    });
  }
  if (map.levels.length !== 3) {
    issues.push({ severity: 'error', area: 'curriculum-map', id: map.id, message: 'CFA curriculum map must include Levels I, II, and III.' });
  }

  const levelIds = new Set<string>();
  map.levels.forEach((levelItem) => {
    if (levelIds.has(levelItem.id)) {
      issues.push({ severity: 'error', area: 'curriculum-map', id: levelItem.id, message: 'Duplicate curriculum level id.' });
    }
    levelIds.add(levelItem.id);
    if (!levelItem.topics.length) {
      issues.push({ severity: 'error', area: 'curriculum-map', id: levelItem.id, message: 'Curriculum level has no topics.' });
    }
    const topicIds = new Set<string>();
    levelItem.topics.forEach((topic) => {
      if (topicIds.has(topic.id)) {
        issues.push({ severity: 'error', area: 'curriculum-map', id: `${levelItem.id}:${topic.id}`, message: 'Duplicate topic id within level.' });
      }
      topicIds.add(topic.id);
    });
  });

  return [
    ...issues,
    ...validateContentBatches(),
    ...validateSourceMeta(map),
    ...validateStudyUnitCoverage(),
    ...validateObjectiveMappings(),
    ...validateAssessmentBlueprints(),
    ...validateSkillLabMappings(),
  ];
}

export function promoteTopicMaturity(
  level: string,
  topicId: string,
  maturity: ContentMaturity = 'exam-ready',
): { promoted: boolean; topic: CurriculumTopic | null; issues: CurriculumValidationIssue[] } {
  const pack = getContentPack(level, topicId);
  const existingTopic = getCurriculumTopic(level, topicId);

  if (!pack) {
    const issues = existingTopic
      ? [
          ...validateStudyUnitCoverage(level, topicId),
          ...validateObjectiveMappings(level, topicId),
          ...validateAssessmentBlueprints(level, topicId),
          ...validateSkillLabMappings(level, topicId),
        ]
      : [{ severity: 'error' as const, area: 'maturity-promotion', id: `${level}:${topicId}`, message: 'Topic not found.' }];
    const blockingIssues = maturity === 'exam-ready' ? issues.filter((issue) => issue.severity === 'error') : [];
    return {
      promoted: blockingIssues.length === 0 && Boolean(existingTopic),
      topic: blockingIssues.length === 0 && existingTopic ? { ...existingTopic, maturity } : existingTopic,
      issues,
    };
  }

  const candidatePack = {
    ...pack,
    maturity,
    sourceMeta: { ...pack.sourceMeta, authoringStatus: maturity },
    authoringReview: { ...pack.authoringReview, status: maturity },
  };
  const issues = isAuthoredContentPack(candidatePack) ? validateAuthoredContentPack(candidatePack) : validateContentPack(candidatePack);
  const blockingIssues = maturity === 'exam-ready' ? issues.filter((issue) => issue.severity === 'error') : [];
  if (blockingIssues.length) {
    return { promoted: false, topic: existingTopic, issues };
  }

  const promotedTopic = contentPackToCurriculumTopic(candidatePack);
  return { promoted: true, topic: promotedTopic, issues };
}

export function generateCurriculumCoverageReport(level?: string): CurriculumCoverageReport {
  const entries = selectedEntries(level);
  const issues = validateCurriculumMap(DEFAULT_CFA_EXAM_YEAR).filter((issue) => {
    if (!level) return true;
    return issue.id.startsWith(`${level}:`) || issue.id.includes(`${level}-`) || issue.id === getCurriculumMap().id;
  });

  const topics = entries.map(({ level: levelItem, topic }) => {
    const counts = getCurriculumTopicCounts(topic);
    return {
      id: topic.id,
      title: topic.title,
      level: levelItem.id,
      maturity: topic.maturity,
      studyUnits: counts.studyUnits,
      lessonSections: counts.lessonSections,
      objectives: counts.objectives,
      formulas: counts.formulas,
      standaloneQuestions: counts.standaloneQuestions,
      vignettes: counts.vignettes,
      constructedResponses: counts.constructedResponses,
      flashcards: counts.flashcards,
      skillLabs: counts.skillLabs,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    examYear: DEFAULT_CFA_EXAM_YEAR,
    level,
    topics,
    totals: {
      levels: level ? 1 : getCurriculumMap().levels.length,
      topics: topics.length,
      examReadyTopics: topics.filter((topic) => topic.maturity === 'exam-ready').length,
      studyUnits: topics.reduce((sum, topic) => sum + topic.studyUnits, 0),
      lessonSections: topics.reduce((sum, topic) => sum + topic.lessonSections, 0),
      objectives: topics.reduce((sum, topic) => sum + topic.objectives, 0),
      formulas: topics.reduce((sum, topic) => sum + topic.formulas, 0),
      standaloneQuestions: topics.reduce((sum, topic) => sum + topic.standaloneQuestions, 0),
      vignettes: topics.reduce((sum, topic) => sum + topic.vignettes, 0),
      constructedResponses: topics.reduce((sum, topic) => sum + topic.constructedResponses, 0),
      flashcards: topics.reduce((sum, topic) => sum + topic.flashcards, 0),
      skillLabs: topics.reduce((sum, topic) => sum + topic.skillLabs, 0),
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
    },
    issues,
  };
}

export function getCurriculumTopicById(level: string, topicId: string): CurriculumTopic | null {
  return getCurriculumTopic(level, topicId);
}
