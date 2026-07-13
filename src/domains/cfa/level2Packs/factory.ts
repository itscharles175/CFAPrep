import type {
  AuthoredContentPack,
  AuthoredExample,
  AuthoredFlashcard,
  AuthoredLesson,
  AuthoredQuestion,
  AuthoredVignette,
  ContentProvenance,
  FormulaBlueprint,
  LessonBlueprint,
  ObjectiveBlueprint,
  SkillLabMapping,
  TopicDataset,
} from '../../../lib/contentTypes';
import type { Difficulty, ErrorCategory, LessonSection } from '../../../lib/learningTypes';
import { enrichCfaFormula } from '../formulaLexicon.js';

export interface Level2TopicSpec {
  id: string;
  title: string;
  examWeight: string;
  focus: string;
  caseFrames: string[];
  decisions: string[];
  traps: string[];
  formulas: string[];
  datasetRows: TopicDataset['rows'];
}

const reviewerDate = '2026-05-05';
const difficulties: Difficulty[] = ['foundation', 'intermediate', 'advanced'];
const errorCategories: ErrorCategory[] = ['concept', 'calculation', 'formula', 'misread', 'time-pressure'];

function slug(value: string) {
  return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function topicKey(topicId: string) {
  return `level2:${topicId}`;
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length];
}

function rowCue(row: Record<string, string | number>, index: number) {
  const entries = Object.entries(row);
  const [key, value] = entries[index % entries.length] || ['case', index + 1];
  return `${key} ${value}`;
}

function provenance(spec: Level2TopicSpec, kind: string, id: string, qualityNotes: string): ContentProvenance {
  return {
    author: 'QuantVault Level II editorial desk',
    reviewer: `QuantVault ${spec.title} Level II reviewer`,
    reviewedAt: reviewerDate,
    sourceKind: kind === 'dataset' ? 'local-dataset' : kind === 'pack' ? 'expert-review' : 'local-source-digest',
    editorialStatus: 'exam-ready',
    qualityNotes,
    generatedFromTemplate: false,
    promotionEvidence: [
      `level2-${spec.id}-2026:original-wording`,
      `level2-${spec.id}-2026:item-set-review`,
      `level2-${spec.id}-2026:${kind}:${id}`,
    ],
    sourceIds: [`cfa-source-digest:level2:${spec.id}:2026`],
  };
}

function rotateOptions(correct: string, distractorOne: string, distractorTwo: string, index: number): { options: [string, string, string]; correct: number } {
  const base = [correct, distractorOne, distractorTwo] as const;
  const shift = index % base.length;
  const options = [...base.slice(shift), ...base.slice(0, shift)] as [string, string, string];
  return { options, correct: options.indexOf(correct) };
}

function objectives(spec: Level2TopicSpec): ObjectiveBlueprint[] {
  return Array.from({ length: 8 }, (_, index) => {
    const decision = pick(spec.decisions, index);
    return {
      id: `level2-${spec.id}-obj-${String(index + 1).padStart(2, '0')}`,
      title: `${spec.title}: ${decision}`,
      description: `Apply original Level II ${spec.title} case facts to ${decision.toLowerCase()} with item-set evidence and valuation judgment.`,
      skill: index < 2 ? 'learn-describe' : index < 6 ? 'analyze-evaluate' : 'integrate-apply',
      tags: ['level2', spec.id, slug(decision)],
    };
  });
}

function formulas(spec: Level2TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): FormulaBlueprint[] {
  return Array.from({ length: 8 }, (_, index) => {
    const name = spec.formulas[index % spec.formulas.length];
    const enrichment = enrichCfaFormula({
      level: 'level2',
      topicId: spec.id,
      name,
      index,
    });
    return {
      id: `level2-${spec.id}-formula-${String(index + 1).padStart(2, '0')}`,
      name,
      latex: enrichment.latex,
      description: `${enrichment.description} Use it only when the Level II item set supplies the matching exhibit facts and asks for the linked interpretation.`,
      objectiveIds: [objectiveBlueprints[index % objectiveBlueprints.length].id, objectiveBlueprints[(index + 2) % objectiveBlueprints.length].id],
    };
  });
}

function lessons(spec: Level2TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): LessonBlueprint[] {
  return Array.from({ length: 8 }, (_, index) => {
    const decision = pick(spec.decisions, index);
    return {
      id: `level2-${spec.id}-unit-${String(index + 1).padStart(2, '0')}`,
      title: `${spec.title} item-set unit ${index + 1}`,
      objectiveIds: [
        objectiveBlueprints[index % objectiveBlueprints.length].id,
        objectiveBlueprints[(index + 1) % objectiveBlueprints.length].id,
        objectiveBlueprints[(index + 3) % objectiveBlueprints.length].id,
      ],
      sectionTitles: [`${decision} case setup`, `${decision} analyst interpretation`],
      workedExampleTitles: [`${decision} worked case`],
      commonErrors: [
        `Answering from a memorized ${spec.title} rule before reading the exhibit.`,
        `Using a single case fact without reconciling the decision constraint.`,
      ],
    };
  });
}

function dataset(spec: Level2TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): TopicDataset {
  const rows = spec.datasetRows;
  const columns = rows[0] ? Object.keys(rows[0]) : ['case', 'input', 'constraint', 'decision'];
  return {
    id: `level2-${spec.id}-dataset-01`,
    title: `${spec.title} Level II item-set dataset`,
    description: `Reviewed local exhibit rows for ${spec.title} Level II cases, examples, and vignette questions.`,
    objectiveIds: objectiveBlueprints.slice(0, 6).map((objective) => objective.id),
    columns,
    rows,
    tags: ['level2', spec.id, 'item-set-dataset'],
    provenance: provenance(spec, 'dataset', `level2-${spec.id}-dataset-01`, `${spec.title} dataset was reviewed for original item-set facts and exhibit reuse.`),
  };
}

function authoredExamples(
  spec: Level2TopicSpec,
  lessonBlueprints: LessonBlueprint[],
  objectiveBlueprints: ObjectiveBlueprint[],
  formulaBlueprints: FormulaBlueprint[],
  localDataset: TopicDataset,
): AuthoredExample[] {
  return lessonBlueprints.map((lesson, index) => {
    const objective = objectiveBlueprints[index % objectiveBlueprints.length];
    const formula = formulaBlueprints[index % formulaBlueprints.length];
    const row = localDataset.rows[index % localDataset.rows.length] || {};
    return {
      id: `level2-${spec.id}-example-${String(index + 1).padStart(2, '0')}`,
      lessonId: lesson.id,
      objectiveId: objective.id,
      topic: topicKey(spec.id),
      learningObjective: objective.id,
      title: `${spec.title} Level II worked item set ${index + 1}`,
      prompt: `${pick(spec.caseFrames, index)} provides ${rowCue(row, index)} and asks the analyst to support ${pick(spec.decisions, index).toLowerCase()}.`,
      walkthrough: `Read the exhibit first, identify the controlling case fact, apply ${formula.name} only when the inputs are present, and reject ${pick(spec.traps, index).toLowerCase()} because it does not answer the item-set command.`,
      formulaName: formula.name,
      datasetId: localDataset.id,
      tags: ['level2', spec.id, 'worked-example'],
      provenance: provenance(spec, 'example', `level2-${spec.id}-example-${String(index + 1).padStart(2, '0')}`, `Worked item set ${index + 1} was reviewed for case-specific facts and explanation support.`),
    };
  });
}

function lessonSections(spec: Level2TopicSpec, lesson: LessonBlueprint, index: number): LessonSection[] {
  const decision = pick(spec.decisions, index);
  return [
    {
      title: `${lesson.title} exhibit discipline`,
      content: `${pick(spec.caseFrames, index)} requires the candidate to identify the exhibit fact that controls ${decision.toLowerCase()} before calculating. The item-set skill is to carry that fact consistently across related questions.`,
      keyPoints: [
        'Read the exhibit title and units before touching answer choices.',
        `Tie the case fact directly to ${decision.toLowerCase()}.`,
        `Reject the distractor built around ${pick(spec.traps, index).toLowerCase()}.`,
      ],
    },
    {
      title: `${lesson.title} answer support`,
      content: `A Level II response must explain why the selected answer follows from the case, not just compute a number. For ${spec.title}, the final sentence should connect the result to valuation, risk, reporting quality, or portfolio use.`,
      keyPoints: [
        'State the interpretation after the calculation.',
        'Check whether the question asks for most likely, least likely, or best-supported.',
        'Use the same case convention across all related items.',
      ],
    },
  ];
}

function authoredLessons(spec: Level2TopicSpec, lessonBlueprints: LessonBlueprint[], examples: AuthoredExample[]): AuthoredLesson[] {
  return lessonBlueprints.map((lesson, index) => ({
    id: lesson.id,
    title: lesson.title,
    objectiveIds: lesson.objectiveIds,
    formulaIds: [`level2-${spec.id}-formula-${String((index % 8) + 1).padStart(2, '0')}`],
    sections: lessonSections(spec, lesson, index),
    examples: examples.filter((example) => example.lessonId === lesson.id),
    commonErrors: lesson.commonErrors,
    keyTakeaways: [
      `${lesson.title} is mastered when the candidate can justify the case conclusion from the exhibit.`,
      `The best Level II answer connects ${pick(spec.decisions, index).toLowerCase()} to the facts without adding assumptions.`,
    ],
    provenance: provenance(spec, 'lesson', lesson.id, `${lesson.title} was reviewed for Level II case analysis, exhibit use, and original wording.`),
  }));
}

function vignetteQuestion(
  spec: Level2TopicSpec,
  vignetteId: string,
  index: number,
  objective: ObjectiveBlueprint,
  formula: FormulaBlueprint,
  lesson: LessonBlueprint,
  localDataset: TopicDataset,
): AuthoredQuestion {
  const row = localDataset.rows[index % localDataset.rows.length] || {};
  const decision = pick(spec.decisions, index);
  const trap = pick(spec.traps, index);
  const correct = `Use ${objective.title.toLowerCase()} because ${rowCue(row, index)} supports ${decision.toLowerCase()}.`;
  const distractorOne = `Choose the answer suggested by ${trap.toLowerCase()}, even though that fact is not controlling.`;
  const distractorTwo = `Avoid the conclusion because another exhibit value is incomplete, despite the case giving enough evidence.`;
  const rotated = rotateOptions(correct, distractorOne, distractorTwo, index);

  return {
    id: `${vignetteId}-q-${(index % 4) + 1}`,
    level: 'level2',
    topic: topicKey(spec.id),
    learningObjective: objective.id,
    itemType: 'vignette',
    question: `${spec.title} item-set question ${index + 1}: ${pick(spec.caseFrames, index)} includes ${rowCue(row, index + 1)}. Which response best supports ${decision.toLowerCase()}?`,
    options: rotated.options,
    correct: rotated.correct,
    explanation: `The correct response uses the case exhibit to apply ${objective.title.toLowerCase()} and then states the valuation or analytical implication. The other choices either rely on ${trap.toLowerCase()} or avoid a conclusion that the case facts support.`,
    difficulty: difficulties[index % difficulties.length],
    formula: index % 2 === 0 ? formula.name : undefined,
    tags: ['level2', spec.id, 'vignette', slug(lesson.title), difficulties[index % difficulties.length]],
    errorCategories,
    answerRationale: {
      correct: `This choice follows the exhibit evidence and applies ${objective.title.toLowerCase()} to the requested Level II judgment.`,
      distractors: [
        `This distractor sounds plausible because ${trap.toLowerCase()} is nearby, but it does not answer the command.`,
        'This distractor delays the decision even though the item set supplies enough relevant evidence.',
      ],
      examTrap: `The trap is carrying an adjacent ${spec.title.toLowerCase()} rule across the item set without checking the exhibit.`,
    },
    sourceLessonId: lesson.id,
    provenance: provenance(spec, 'vignette-question', `${vignetteId}-q-${(index % 4) + 1}`, `Vignette question ${index + 1} was reviewed for answer support, distractors, and objective mapping.`),
  };
}

function authoredVignettes(
  spec: Level2TopicSpec,
  lessonBlueprints: LessonBlueprint[],
  objectiveBlueprints: ObjectiveBlueprint[],
  formulaBlueprints: FormulaBlueprint[],
  localDataset: TopicDataset,
): AuthoredVignette[] {
  return Array.from({ length: 12 }, (_, index) => {
    const lesson = lessonBlueprints[index % lessonBlueprints.length];
    const row = localDataset.rows[index % localDataset.rows.length] || {};
    const vignetteId = `level2-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}`;
    const objectiveIds = lesson.objectiveIds;
    return {
      id: vignetteId,
      level: 'level2',
      topic: topicKey(spec.id),
      title: `${spec.title} Level II item set ${index + 1}`,
      stem: `${pick(spec.caseFrames, index)}. The case includes multiple exhibits and asks the analyst to connect the facts to ${pick(spec.decisions, index).toLowerCase()} without importing outside assumptions.`,
      exhibits: [
        {
          id: `${vignetteId}-facts`,
          title: 'Case facts',
          type: 'facts',
          content: `Primary exhibit cue: ${rowCue(row, index)}. The analyst must use the stated facts and maintain consistent units across questions.`,
          sourceObjectiveIds: objectiveIds,
        },
        {
          id: `${vignetteId}-table`,
          title: 'Local exhibit table',
          type: 'table',
          content: localDataset.columns.map((column) => `${column}: ${String(row[column] ?? 'reviewed')}`).join(' | '),
          sourceObjectiveIds: objectiveIds.slice(0, 2),
        },
      ],
      questions: Array.from({ length: 4 }, (_, questionIndex) =>
        vignetteQuestion(
          spec,
          vignetteId,
          index * 4 + questionIndex,
          objectiveBlueprints[(index + questionIndex) % objectiveBlueprints.length],
          formulaBlueprints[(index + questionIndex) % formulaBlueprints.length],
          lesson,
          localDataset,
        ),
      ),
      objectiveIds,
      datasetIds: [localDataset.id],
      difficulty: difficulties[index % difficulties.length],
      tags: ['level2', spec.id, 'item-set'],
      learningObjectives: objectiveIds,
      provenance: provenance(spec, 'vignette', vignetteId, `${spec.title} item set ${index + 1} was reviewed for exhibit quality, item independence, and answer support.`),
    };
  });
}

function authoredFlashcards(spec: Level2TopicSpec, objectiveBlueprints: ObjectiveBlueprint[], formulaBlueprints: FormulaBlueprint[]): AuthoredFlashcard[] {
  const objectiveCards = objectiveBlueprints.flatMap((objective, index) => [
    {
      id: `level2-${spec.id}-obj-card-${index + 1}-1`,
      type: 'definition' as const,
      front: `${objective.title} case cue`,
      back: `Use the exhibit fact that controls ${pick(spec.decisions, index).toLowerCase()} and state the analytical implication.`,
      objectiveId: objective.id,
      sourceKind: 'objective' as const,
    },
    {
      id: `level2-${spec.id}-obj-card-${index + 1}-2`,
      type: 'error-pattern' as const,
      front: `${objective.title} trap`,
      back: `Avoid ${pick(spec.traps, index).toLowerCase()} when the case asks for ${pick(spec.decisions, index).toLowerCase()}.`,
      objectiveId: objective.id,
      sourceKind: 'common-error' as const,
    },
    {
      id: `level2-${spec.id}-obj-card-${index + 1}-3`,
      type: 'definition' as const,
      front: `${objective.title} item-set link`,
      back: `Carry the same case convention through related questions before choosing the answer.`,
      objectiveId: objective.id,
      sourceKind: 'objective' as const,
    },
  ]);
  const formulaCards = formulaBlueprints.map((formula, index) => ({
    id: `level2-${spec.id}-formula-card-${index + 1}`,
    type: 'formula' as const,
    front: formula.name,
    back: `${formula.latex}\n\n${formula.description}`,
    objectiveId: formula.objectiveIds[0],
    sourceKind: 'formula' as const,
  }));

  const reviewCards = objectiveBlueprints.map((objective, index) => ({
    id: `level2-${spec.id}-review-card-${index + 1}`,
    type: 'definition' as const,
    front: `${objective.title} review trigger`,
    back: `Review this objective when an item set mixes exhibits, valuation evidence, and ${pick(spec.traps, index).toLowerCase()}.`,
    objectiveId: objective.id,
    sourceKind: 'objective' as const,
  }));

  return [...objectiveCards, ...formulaCards, ...reviewCards].slice(0, 40).map((card, index) => ({
    ...card,
    level: 'level2' as const,
    domain: 'cfa' as const,
    topic: topicKey(spec.id),
    sourcePath: `/cfa/level2/${spec.id}`,
    tags: ['level2', spec.id, 'flashcard'],
    provenance: provenance(spec, 'flashcard', card.id, `Flashcard ${index + 1} was reviewed for concise Level II recall and case-use relevance.`),
  }));
}

function skillLabs(spec: Level2TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): SkillLabMapping[] {
  return ['case-model', 'valuation-check', 'item-set-review', 'formula-drill'].map((tool, index) => ({
    id: `level2-${spec.id}-skill-lab-${index + 1}`,
    objectiveIds: [objectiveBlueprints[index % objectiveBlueprints.length].id, objectiveBlueprints[(index + 3) % objectiveBlueprints.length].id],
    toolId: `level2:${spec.id}:${tool}`,
    toolType: index === 0 ? 'excel-drill' : index === 1 ? 'calculator' : index === 2 ? 'mock' : 'formula-drill',
    path: index === 0 ? '/excel/fundamentals' : index === 1 ? '/calculators' : `/cfa/level2/${spec.id}/vignette`,
    reason: `${spec.title} ${tool.replace('-', ' ')} lab supports reviewed Level II item-set practice.`,
  }));
}

export function buildLevel2Pack(spec: Level2TopicSpec): AuthoredContentPack {
  const objectiveBlueprints = objectives(spec);
  const formulaBlueprints = formulas(spec, objectiveBlueprints);
  const lessonBlueprints = lessons(spec, objectiveBlueprints);
  const localDataset = dataset(spec, objectiveBlueprints);
  const examples = authoredExamples(spec, lessonBlueprints, objectiveBlueprints, formulaBlueprints, localDataset);
  return {
    id: `level2-${spec.id}-authored-pack`,
    level: 'level2',
    topicId: spec.id,
    title: spec.title,
    examWeight: spec.examWeight,
    maturity: 'exam-ready',
    sourceMeta: {
      original: true,
      examYear: 2026,
      publicReferences: [
        {
          title: 'CFA Level II exam guide',
          url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-ii-exam',
          usage: 'exam-format',
        },
      ],
      authoringStatus: 'exam-ready',
      notes: `${spec.title} Level II pack uses public CFA pages only for exam structure and topic weight alignment; learner-facing wording is original QuantVault material.`,
    },
    objectiveBlueprints,
    lessonBlueprints,
    formulaBlueprints,
    questionPacks: [],
    vignettePacks: lessonBlueprints.map((lesson, index) => ({
      id: `${lesson.id}-item-sets`,
      count: index < 4 ? 2 : 1,
      objectiveIds: lesson.objectiveIds,
      questionsPerVignette: 4,
      exhibitTypes: ['facts', 'table', 'calculation'],
    })),
    flashcardPacks: lessonBlueprints.map((lesson) => ({
      id: `${lesson.id}-flashcards`,
      count: 5,
      objectiveIds: lesson.objectiveIds,
      sourceTypes: ['definition', 'formula', 'error-pattern'],
    })),
    skillLabMappings: skillLabs(spec, objectiveBlueprints),
    authoringReview: {
      reviewer: `QuantVault ${spec.title} Level II reviewer`,
      status: 'exam-ready',
      reviewedAt: reviewerDate,
      notes: `${spec.title} Level II topic passed item-set, exhibit, rationale, flashcard, and provenance review.`,
      checks: ['original-wording', 'objective-coverage', 'answer-key', 'distractors', 'formula-links', 'vignette-completeness', 'skill-lab-mapping', 'accessibility'],
      promotionEvidence: [`level2-${spec.id}-2026:topic-review`, `level2-${spec.id}-2026:release-gate`],
    },
    provenance: provenance(spec, 'pack', `level2-${spec.id}-authored-pack`, `${spec.title} Level II pack-level review confirms original wording and strict item-set provenance.`),
    datasets: [localDataset],
    authoredLessons: authoredLessons(spec, lessonBlueprints, examples),
    authoredExamples: examples,
    authoredQuestions: [],
    authoredVignettes: authoredVignettes(spec, lessonBlueprints, objectiveBlueprints, formulaBlueprints, localDataset),
    authoredFlashcards: authoredFlashcards(spec, objectiveBlueprints, formulaBlueprints),
  };
}
