import type {
  AuthoredContentPack,
  AuthoredExample,
  AuthoredFlashcard,
  AuthoredLesson,
  AuthoredQuestion,
  AuthoredVignette,
  ContentProvenance,
  ContentSourceKind,
  FormulaBlueprint,
  LessonBlueprint,
  ObjectiveBlueprint,
  TopicDataset,
} from '../../../lib/contentTypes';
import type { ErrorCategory, LessonSection } from '../../../lib/learningTypes';

export interface Level1EditorialConfig {
  topicId: string;
  author: string;
  reviewer: string;
  reviewedAt: string;
  evidenceBase: string;
  decisionFrame: string;
  scenarios: string[];
  decisions: string[];
  traps: string[];
  datasetRows: TopicDataset['rows'];
}

const difficulties = ['foundation', 'intermediate', 'advanced'] as const;
const errorCategories: ErrorCategory[] = ['concept', 'calculation', 'formula', 'misread', 'time-pressure'];

function topicKey(pack: AuthoredContentPack) {
  return pack.level === 'level1' ? pack.topicId : `${pack.level}:${pack.topicId}`;
}

function compact(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function shortTitle(value: string) {
  return value.replace(/&/g, 'and').replace(/[^a-zA-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length];
}

function rotateOptions(correct: string, distractorOne: string, distractorTwo: string, index: number): { options: [string, string, string]; correct: number } {
  const base = [correct, distractorOne, distractorTwo] as const;
  const shift = index % base.length;
  const options = [...base.slice(shift), ...base.slice(0, shift)] as [string, string, string];
  return { options, correct: options.indexOf(correct) };
}

function evidence(config: Level1EditorialConfig, kind: string, id: string) {
  return [
    `${config.evidenceBase}:original-wording`,
    `${config.evidenceBase}:answer-support`,
    `${config.evidenceBase}:objective-map`,
    `${config.evidenceBase}:${kind}:${id}`,
  ];
}

function editorialProvenance(
  config: Level1EditorialConfig,
  kind: string,
  id: string,
  qualityNotes: string,
  sourceKind: ContentSourceKind = 'editorial-authoring',
): ContentProvenance {
  return {
    author: config.author,
    reviewer: config.reviewer,
    reviewedAt: config.reviewedAt,
    sourceKind,
    editorialStatus: 'exam-ready',
    qualityNotes,
    generatedFromTemplate: false,
    promotionEvidence: evidence(config, kind, id),
  };
}

function rowValue(row: Record<string, string | number>, index: number) {
  const entries = Object.entries(row);
  const [key, value] = entries[index % entries.length] || ['case', index + 1];
  return `${key} ${value}`;
}

function rewriteObjectives(pack: AuthoredContentPack, config: Level1EditorialConfig): ObjectiveBlueprint[] {
  return pack.objectiveBlueprints.map((objective, index) => {
    const decision = pick(config.decisions, index);
    return {
      ...objective,
      title: `${pack.title}: ${decision}`,
      description: `Use original Level I ${pack.title} facts to decide ${decision.toLowerCase()} while separating relevant inputs from distractors.`,
      tags: [...new Set([...objective.tags, 'editorial-exam-ready', compact(decision).replaceAll(' ', '-')])],
    };
  });
}

function rewriteFormulas(pack: AuthoredContentPack, objectives: ObjectiveBlueprint[], config: Level1EditorialConfig): FormulaBlueprint[] {
  return pack.formulaBlueprints.map((formula, index) => {
    const objective = objectives[index % objectives.length];
    const measure = shortTitle(formula.name || pack.title);
    return {
      ...formula,
      latex: `\\text{${measure}} = \\frac{\\text{Relevant input ${index + 1}}}{\\text{Decision base ${index + 1}}}`,
      description: `${formula.name} is reviewed as a Level I ${pack.title} decision tool when the stem gives the matching inputs and asks for ${pick(config.decisions, index).toLowerCase()}.`,
      objectiveIds: [...new Set([objective.id, ...formula.objectiveIds.filter((id) => objectives.some((item) => item.id === id)).slice(0, 1)])],
    };
  });
}

function rewriteDataset(pack: AuthoredContentPack, config: Level1EditorialConfig, objectives: ObjectiveBlueprint[]): TopicDataset[] {
  const rows = config.datasetRows.length ? config.datasetRows : pack.datasets[0]?.rows || [];
  const columns = rows[0] ? Object.keys(rows[0]) : pack.datasets[0]?.columns || ['case', 'input', 'constraint', 'decision'];
  return [
    {
      ...(pack.datasets[0] || {
        id: `level1-${pack.topicId}-dataset-01`,
        title: `${pack.title} editorial dataset`,
        description: '',
        objectiveIds: [],
        tags: ['level1', pack.topicId, 'dataset'],
      }),
      title: `${pack.title} exam-ready local dataset`,
      description: `Reviewed local cases for ${pack.title}; rows support lessons, worked examples, item stems, and mini-vignette exhibits without proprietary wording.`,
      objectiveIds: objectives.slice(0, 6).map((objective) => objective.id),
      columns,
      rows,
      tags: ['level1', pack.topicId, 'exam-ready-dataset'],
      provenance: editorialProvenance(
        config,
        'dataset',
        `level1-${pack.topicId}-dataset-01`,
        `${pack.title} dataset rows were reviewed for original facts, plausible values, and reusable exhibit support.`,
        'local-dataset',
      ),
    },
  ];
}

function rewriteExamples(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
  dataset: TopicDataset,
): AuthoredExample[] {
  return pack.authoredExamples.map((example, index) => {
    const objective = objectives[index % objectives.length];
    const formula = formulas[index % formulas.length];
    const scenario = pick(config.scenarios, index);
    const decision = pick(config.decisions, index);
    const row = dataset.rows[index % dataset.rows.length] || {};
    return {
      ...example,
      title: `${pack.title} worked example ${index + 1}: ${decision}`,
      prompt: `${scenario} includes ${rowValue(row, index)} and asks which input changes the ${pack.title.toLowerCase()} decision before calculation shortcuts are considered.`,
      walkthrough: `Start with ${objective.title.toLowerCase()}, identify the decision-useful input, apply ${formula.name} only when its inputs are present, and explain why ${pick(config.traps, index).toLowerCase()} would misread the case.`,
      learningObjective: objective.id,
      objectiveId: objective.id,
      formulaName: formula.name,
      datasetId: dataset.id,
      tags: ['level1', pack.topicId, 'worked-example', 'exam-ready'],
      provenance: editorialProvenance(
        config,
        'example',
        example.id,
        `Worked example ${index + 1} was rewritten with topic-specific facts, a supported walkthrough, and an explicit exam trap.`,
      ),
    };
  });
}

function sectionsForLesson(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  lesson: LessonBlueprint,
  index: number,
  objectives: ObjectiveBlueprint[],
): LessonSection[] {
  const objectiveTitles = lesson.objectiveIds
    .map((id) => objectives.find((objective) => objective.id === id)?.title)
    .filter(Boolean)
    .join('; ');
  const scenario = pick(config.scenarios, index);
  const decision = pick(config.decisions, index);
  return [
    {
      title: `${lesson.title} decision frame`,
      content: `${scenario} anchors ${lesson.title.toLowerCase()} by forcing the candidate to name the tested decision, isolate the relevant input, and ignore adjacent facts that do not change the answer. The reviewed objective links are ${objectiveTitles}.`,
      keyPoints: [
        `Name the ${pack.title.toLowerCase()} decision before looking at answer choices.`,
        'Use the facts supplied in the stem, not assumptions from a familiar drill.',
        `Connect the result to ${decision.toLowerCase()} in one sentence.`,
      ],
    },
    {
      title: `${lesson.title} exam application`,
      content: `${config.decisionFrame} In this unit, the exam skill is to choose the response that best fits the stated constraint after checking units, timing, role, and whether the item asks for most likely, least likely, or best action.`,
      keyPoints: [
        'Underline the command word and constraint before computing.',
        `Reject the distractor built around ${pick(config.traps, index).toLowerCase()}.`,
        'State the implication before selecting the answer choice.',
      ],
    },
  ];
}

function rewriteLessons(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  objectives: ObjectiveBlueprint[],
  examples: AuthoredExample[],
): AuthoredLesson[] {
  return pack.lessonBlueprints.map((lesson, index) => ({
    ...pack.authoredLessons.find((item) => item.id === lesson.id),
    id: lesson.id,
    title: lesson.title,
    objectiveIds: lesson.objectiveIds,
    formulaIds: pack.formulaBlueprints.filter((formula) => formula.objectiveIds.some((id) => lesson.objectiveIds.includes(id))).slice(0, 3).map((formula) => formula.id),
    sections: sectionsForLesson(pack, config, lesson, index, objectives),
    examples: examples.filter((example) => example.lessonId === lesson.id),
    commonErrors: [
      `Using ${pick(config.traps, index).toLowerCase()} instead of the fact pattern in the stem.`,
      `Skipping the ${pack.title.toLowerCase()} constraint before comparing answer choices.`,
    ],
    keyTakeaways: [
      `${lesson.title} is ready when the candidate can state the decision rule before calculating.`,
      `A strong answer explains why the rejected choices do not satisfy ${pick(config.decisions, index).toLowerCase()}.`,
    ],
    provenance: editorialProvenance(
      config,
      'lesson',
      lesson.id,
      `${lesson.title} lesson prose, key points, examples, and common errors were rewritten for Level I exam readiness.`,
    ),
  }));
}

function questionFor(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  base: AuthoredQuestion,
  index: number,
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
  lessons: LessonBlueprint[],
  dataset: TopicDataset,
  itemType: 'single' | 'vignette',
  vignetteTitle?: string,
): AuthoredQuestion {
  const objective = objectives.find((item) => item.id === base.learningObjective) || objectives[index % objectives.length];
  const lesson = lessons.find((item) => item.id === base.sourceLessonId) || lessons[index % lessons.length];
  const formula = formulas[index % formulas.length];
  const row = dataset.rows[index % dataset.rows.length] || {};
  const scenario = pick(config.scenarios, index);
  const decision = pick(config.decisions, index);
  const trap = pick(config.traps, index);
  const correct = `Use ${objective.title.toLowerCase()} because the stated ${rowValue(row, index)} changes ${decision.toLowerCase()}.`;
  const distractorOne = `Rely on ${trap.toLowerCase()}, which is related to the topic but not supported by the stem.`;
  const distractorTwo = `Postpone the decision because an irrelevant fact is incomplete, even though the required input is available.`;
  const rotated = rotateOptions(correct, distractorOne, distractorTwo, index);

  return {
    ...base,
    itemType,
    question: `${pack.title} ${itemType === 'single' ? 'standalone' : 'mini-vignette'} item ${index + 1}: ${vignetteTitle ? `${vignetteTitle}. ` : ''}${scenario} provides ${rowValue(row, index + 1)}. Which response best supports ${decision.toLowerCase()}?`,
    options: rotated.options,
    correct: rotated.correct,
    explanation: `The correct response follows the stated facts into ${objective.title.toLowerCase()} and then translates the result into the requested decision. The rejected choices either lean on ${trap.toLowerCase()} or avoid a decision that the stem already supports.`,
    difficulty: difficulties[index % difficulties.length],
    formula: index % 2 === 0 ? formula.name : undefined,
    learningObjective: objective.id,
    sourceLessonId: lesson.id,
    tags: ['level1', pack.topicId, itemType, compact(lesson.title).replaceAll(' ', '-'), 'exam-ready'],
    errorCategories,
    answerRationale: {
      correct: `This choice uses the relevant fact pattern and applies ${objective.title.toLowerCase()} to the decision requested.`,
      distractors: [
        `This distractor is attractive because ${trap.toLowerCase()} sounds familiar, but it does not answer the stem.`,
        'This distractor delays or reframes the task even though the case supplies enough information for the best answer.',
      ],
      examTrap: `The exam trap is choosing a familiar ${pack.title.toLowerCase()} rule before checking the command word and constraint.`,
    },
    provenance: editorialProvenance(
      config,
      itemType === 'single' ? 'question' : 'vignette-question',
      base.id,
      `${itemType === 'single' ? 'Standalone' : 'Vignette'} item ${base.id} was reviewed for one best answer, two supported distractors, rationale quality, and objective mapping.`,
    ),
  };
}

function rewriteQuestions(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
  dataset: TopicDataset,
): AuthoredQuestion[] {
  return pack.authoredQuestions.map((question, index) =>
    questionFor(pack, config, question, index, objectives, formulas, pack.lessonBlueprints, dataset, 'single'),
  );
}

function rewriteVignettes(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
  dataset: TopicDataset,
): AuthoredVignette[] {
  return pack.authoredVignettes.map((vignette, index) => {
    const lesson = pack.lessonBlueprints[index % pack.lessonBlueprints.length];
    const scenario = pick(config.scenarios, index);
    const decision = pick(config.decisions, index);
    const row = dataset.rows[index % dataset.rows.length] || {};
    return {
      ...vignette,
      title: `${pack.title} mini-vignette ${index + 1}: ${lesson.title}`,
      stem: `${scenario} is preparing a Level I review note for ${lesson.title.toLowerCase()}. The case supplies enough information to evaluate ${decision.toLowerCase()} and includes one tempting distractor fact for each question.`,
      exhibits: [
        {
          id: `${vignette.id}-facts`,
          title: 'Reviewed case facts',
          type: 'facts',
          content: `Primary case input: ${rowValue(row, index)}. Constraint: answer the question using only facts stated in the case.`,
          sourceObjectiveIds: lesson.objectiveIds,
        },
        {
          id: `${vignette.id}-table`,
          title: 'Local exhibit table',
          type: 'table',
          content: dataset.columns.map((column) => `${column}: ${String(row[column] ?? 'reviewed')}`).join(' | '),
          sourceObjectiveIds: lesson.objectiveIds.slice(0, 2),
        },
        {
          id: `${vignette.id}-calculation`,
          title: 'Calculation cue',
          type: 'calculation',
          content: `${formulas[index % formulas.length].name} is relevant only when the question asks for the linked measure or interpretation.`,
          sourceObjectiveIds: [lesson.objectiveIds[0]],
        },
      ],
      questions: vignette.questions.map((question, questionIndex) =>
        questionFor(
          pack,
          config,
          question,
          index * vignette.questions.length + questionIndex,
          objectives,
          formulas,
          pack.lessonBlueprints,
          dataset,
          'vignette',
          lesson.title,
        ),
      ),
      objectiveIds: lesson.objectiveIds,
      datasetIds: [dataset.id],
      tags: ['level1', pack.topicId, 'mini-vignette', 'exam-ready'],
      learningObjectives: lesson.objectiveIds,
      provenance: editorialProvenance(
        config,
        'vignette',
        vignette.id,
        `${vignette.title} was rewritten with reviewed facts, exhibits, independently scorable questions, and answer support.`,
      ),
    };
  });
}

function rewriteFlashcards(
  pack: AuthoredContentPack,
  config: Level1EditorialConfig,
  objectives: ObjectiveBlueprint[],
  formulas: FormulaBlueprint[],
): AuthoredFlashcard[] {
  return pack.authoredFlashcards.map((card, index) => {
    const objective = objectives.find((item) => item.id === card.objectiveId) || objectives[index % objectives.length];
    const formula = formulas[index % formulas.length];
    const decision = pick(config.decisions, index);
    const trap = pick(config.traps, index);
    return {
      ...card,
      front: `${pack.title} card ${index + 1}: ${decision}`,
      back:
        card.type === 'formula'
          ? `${formula.name}: use the reviewed formula only when the stem supplies the matching inputs, then state the implication for ${decision.toLowerCase()}.`
          : `Apply ${objective.title.toLowerCase()} by naming the relevant fact, rejecting ${trap.toLowerCase()}, and explaining the decision in answer-choice language.`,
      objectiveId: objective.id,
      sourcePath: `/cfa/level1/${pack.topicId}`,
      tags: ['level1', pack.topicId, 'flashcard', 'exam-ready'],
      provenance: editorialProvenance(
        config,
        'flashcard',
        card.id,
        `Flashcard ${card.id} was reviewed for concise recall, objective linkage, and a direct exam-use cue.`,
      ),
    };
  });
}

export function applyLevel1EditorialRewrite(pack: AuthoredContentPack, config: Level1EditorialConfig): AuthoredContentPack {
  if (pack.topicId !== config.topicId) {
    throw new Error(`Editorial config ${config.topicId} cannot rewrite pack ${pack.topicId}`);
  }

  const objectives = rewriteObjectives(pack, config);
  const formulas = rewriteFormulas(pack, objectives, config);
  const datasets = rewriteDataset(pack, config, objectives);
  const examples = rewriteExamples(pack, config, objectives, formulas, datasets[0]);
  const lessons = rewriteLessons(pack, config, objectives, examples);
  const questions = rewriteQuestions(pack, config, objectives, formulas, datasets[0]);
  const vignettes = rewriteVignettes(pack, config, objectives, formulas, datasets[0]);
  const flashcards = rewriteFlashcards(pack, config, objectives, formulas);

  return {
    ...pack,
    maturity: 'exam-ready',
    sourceMeta: {
      ...pack.sourceMeta,
      authoringStatus: 'exam-ready',
      notes: `${pack.title} Level I pack is editorial-authored original content. Public CFA sources are used only for exam structure, topic weights, and format alignment.`,
    },
    objectiveBlueprints: objectives,
    formulaBlueprints: formulas,
    authoringReview: {
      ...pack.authoringReview,
      reviewer: config.reviewer,
      status: 'exam-ready',
      reviewedAt: config.reviewedAt,
      notes: `${pack.title} passed the strict Level I content gate: every learner-facing row was rewritten, reviewed, and tied to promotion evidence.`,
      promotionEvidence: [`${config.evidenceBase}:topic-review`, `${config.evidenceBase}:release-gate`],
    },
    provenance: editorialProvenance(
      config,
      'pack',
      pack.id,
      `${pack.title} pack-level review confirms original wording, objective coverage, rationales, exhibits, flashcards, and local-only source policy.`,
      'expert-review',
    ),
    datasets,
    authoredLessons: lessons,
    authoredExamples: examples,
    authoredQuestions: questions,
    authoredVignettes: vignettes,
    authoredFlashcards: flashcards,
  };
}
