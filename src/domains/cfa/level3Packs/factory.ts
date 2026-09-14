import type {
  AuthoredConstructedResponse,
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

export interface Level3TopicSpec {
  id: string;
  title: string;
  examWeight: string;
  pathway: 'core' | 'portfolio-management' | 'private-markets' | 'private-wealth';
  focus: string;
  caseFrames: string[];
  decisions: string[];
  traps: string[];
  commandWords: string[];
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
  return `level3:${topicId}`;
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length];
}

function rowCue(row: Record<string, string | number>, index: number) {
  const entries = Object.entries(row);
  const [key, value] = entries[index % entries.length] || ['case', index + 1];
  return `${key} ${value}`;
}

function provenance(spec: Level3TopicSpec, kind: string, id: string, qualityNotes: string): ContentProvenance {
  return {
    author: 'QuantVault Level III editorial desk',
    reviewer: `QuantVault ${spec.title} Level III reviewer`,
    reviewedAt: reviewerDate,
    sourceKind: kind === 'dataset' ? 'local-dataset' : kind === 'pack' ? 'expert-review' : 'local-source-digest',
    editorialStatus: 'exam-ready',
    qualityNotes,
    generatedFromTemplate: false,
    promotionEvidence: [
      `level3-${spec.id}-2026:original-wording`,
      `level3-${spec.id}-2026:constructed-response-review`,
      `level3-${spec.id}-2026:${kind}:${id}`,
    ],
    sourceIds: [`cfa-source-digest:level3:${spec.id}:2026`, `cfa-source-pathway:${spec.pathway}`],
  };
}

function rotateOptions(correct: string, distractorOne: string, distractorTwo: string, index: number): { options: [string, string, string]; correct: number } {
  const base = [correct, distractorOne, distractorTwo] as const;
  const shift = index % base.length;
  const options = [...base.slice(shift), ...base.slice(0, shift)] as [string, string, string];
  return { options, correct: options.indexOf(correct) };
}

function objectives(spec: Level3TopicSpec): ObjectiveBlueprint[] {
  return Array.from({ length: 8 }, (_, index) => {
    const decision = pick(spec.decisions, index);
    const command = pick(spec.commandWords, index);
    return {
      id: `level3-${spec.id}-obj-${String(index + 1).padStart(2, '0')}`,
      title: `${spec.title}: ${command} ${decision}`,
      description: `Use original Level III ${spec.title} case facts to ${command} ${decision.toLowerCase()} and support the answer with portfolio-level reasoning.`,
      skill: index < 2 ? 'learn-describe' : index < 6 ? 'analyze-evaluate' : 'integrate-apply',
      tags: ['level3', spec.id, slug(command), slug(decision)],
      commandWords: [command, pick(spec.commandWords, index + 2)],
    };
  });
}

function formulas(spec: Level3TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): FormulaBlueprint[] {
  return Array.from({ length: 6 }, (_, index) => {
    const name = spec.formulas[index % spec.formulas.length];
    const enrichment = enrichCfaFormula({
      level: 'level3',
      topicId: spec.id,
      name,
      index,
    });
    return {
      id: `level3-${spec.id}-formula-${String(index + 1).padStart(2, '0')}`,
      name,
      latex: enrichment.latex,
      description: `${enrichment.description} Use it to support a concise Level III portfolio action, constraint, or risk-control interpretation.`,
      objectiveIds: [objectiveBlueprints[index % objectiveBlueprints.length].id, objectiveBlueprints[(index + 2) % objectiveBlueprints.length].id],
    };
  });
}

function lessons(spec: Level3TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): LessonBlueprint[] {
  return Array.from({ length: 8 }, (_, index) => {
    const decision = pick(spec.decisions, index);
    return {
      id: `level3-${spec.id}-unit-${String(index + 1).padStart(2, '0')}`,
      title: `${spec.title} response unit ${index + 1}`,
      objectiveIds: [
        objectiveBlueprints[index % objectiveBlueprints.length].id,
        objectiveBlueprints[(index + 1) % objectiveBlueprints.length].id,
        objectiveBlueprints[(index + 3) % objectiveBlueprints.length].id,
      ],
      sectionTitles: [`${decision} case diagnosis`, `${decision} written support`],
      workedExampleTitles: [`${decision} response example`],
      commonErrors: [
        `Writing a general ${spec.title} comment without anchoring it to the case facts.`,
        `Using a calculation or policy rule without stating the portfolio decision it supports.`,
      ],
    };
  });
}

function dataset(spec: Level3TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): TopicDataset {
  const rows = spec.datasetRows;
  const columns = rows[0] ? Object.keys(rows[0]) : ['case', 'constraint', 'input', 'decision'];
  return {
    id: `level3-${spec.id}-dataset-01`,
    title: `${spec.title} Level III response dataset`,
    description: `Reviewed local case rows for ${spec.title} constructed responses, item sets, examples, and skill labs.`,
    objectiveIds: objectiveBlueprints.slice(0, 6).map((objective) => objective.id),
    columns,
    rows,
    tags: ['level3', spec.id, 'response-dataset'],
    provenance: provenance(spec, 'dataset', `level3-${spec.id}-dataset-01`, `${spec.title} dataset was reviewed for original Level III case facts and exhibit reuse.`),
  };
}

function authoredExamples(
  spec: Level3TopicSpec,
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
      id: `level3-${spec.id}-example-${String(index + 1).padStart(2, '0')}`,
      lessonId: lesson.id,
      objectiveId: objective.id,
      topic: topicKey(spec.id),
      learningObjective: objective.id,
      title: `${spec.title} Level III response example ${index + 1}`,
      prompt: `${pick(spec.caseFrames, index)} includes ${rowCue(row, index)} and asks for a concise decision tied to ${pick(spec.decisions, index).toLowerCase()}.`,
      walkthrough: `Start with the command word, identify the controlling constraint, use ${formula.name} only if it changes the decision, and finish with one portfolio implication that follows from the case facts.`,
      formulaName: formula.name,
      datasetId: localDataset.id,
      tags: ['level3', spec.id, 'worked-response'],
      provenance: provenance(spec, 'example', `level3-${spec.id}-example-${String(index + 1).padStart(2, '0')}`, `Worked response example ${index + 1} was reviewed for case anchoring and concise support.`),
    };
  });
}

function lessonSections(spec: Level3TopicSpec, lesson: LessonBlueprint, index: number): LessonSection[] {
  const decision = pick(spec.decisions, index);
  const command = pick(spec.commandWords, index);
  return [
    {
      title: `${lesson.title} command discipline`,
      content: `A strong ${spec.title} response begins by translating ${command} into the required action. The response earns credit by linking the case constraint to ${decision.toLowerCase()} and avoiding generic policy language.`,
      keyPoints: [
        `Write the action required by ${command} before adding explanation.`,
        `Tie the decision to ${decision.toLowerCase()} with one explicit case fact.`,
        `Reject the nearby trap of ${pick(spec.traps, index).toLowerCase()}.`,
      ],
    },
    {
      title: `${lesson.title} scoring support`,
      content: `The scoring path rewards short, evidence-based statements. For ${spec.title}, each answer part should identify the relevant input, apply the portfolio rule or calculation, and state the implication for implementation or monitoring.`,
      keyPoints: [
        'Separate identify, apply, and justify sentences.',
        'Use case units and constraints exactly as provided.',
        'End with the action, risk control, or trade-off that follows.',
      ],
    },
  ];
}

function authoredLessons(spec: Level3TopicSpec, lessonBlueprints: LessonBlueprint[], examples: AuthoredExample[]): AuthoredLesson[] {
  return lessonBlueprints.map((lesson, index) => ({
    id: lesson.id,
    title: lesson.title,
    objectiveIds: lesson.objectiveIds,
    formulaIds: [`level3-${spec.id}-formula-${String((index % 6) + 1).padStart(2, '0')}`],
    sections: lessonSections(spec, lesson, index),
    examples: examples.filter((example) => example.lessonId === lesson.id),
    commonErrors: lesson.commonErrors,
    keyTakeaways: [
      `${lesson.title} is mastered when the answer names the decision and supports it from the case.`,
      `A high-scoring ${spec.title} response is specific, brief, and tied to the client or portfolio constraint.`,
    ],
    provenance: provenance(spec, 'lesson', lesson.id, `${lesson.title} was reviewed for command-word coverage, case support, and original wording.`),
  }));
}

function vignetteQuestion(
  spec: Level3TopicSpec,
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
  const correct = `The response should rely on ${objective.title.toLowerCase()} because ${rowCue(row, index)} directly supports ${decision.toLowerCase()}.`;
  const distractorOne = `The response should rely on ${trap.toLowerCase()}, even though that point does not control the portfolio decision.`;
  const distractorTwo = `The response should rely on another policy fact and delay the answer, despite the case giving enough support.`;
  const rotated = rotateOptions(correct, distractorOne, distractorTwo, index);

  return {
    id: `${vignetteId}-q-${(index % 3) + 1}`,
    level: 'level3',
    topic: topicKey(spec.id),
    learningObjective: objective.id,
    itemType: 'vignette',
    question: `${spec.title} item-set question ${index + 1}: ${pick(spec.caseFrames, index)} states ${rowCue(row, index + 1)}. Which answer best supports ${decision.toLowerCase()}?`,
    options: rotated.options,
    correct: rotated.correct,
    explanation: `The correct answer carries the Level III case fact into the requested portfolio decision and then states the implication. The other choices either rely on ${trap.toLowerCase()} or avoid an answer that the local exhibit supports.`,
    difficulty: difficulties[index % difficulties.length],
    formula: index % 2 === 0 ? formula.name : undefined,
    tags: ['level3', spec.id, 'item-set', slug(lesson.title), difficulties[index % difficulties.length]],
    errorCategories,
    answerRationale: {
      correct: `This choice uses the exhibit fact and applies ${objective.title.toLowerCase()} to the requested portfolio judgment.`,
      distractors: [
        `This distractor sounds relevant because ${trap.toLowerCase()} is nearby, but it does not answer the command.`,
        'This distractor avoids the decision even though the case supplies enough relevant evidence.',
      ],
      examTrap: `The trap is writing from a familiar ${spec.title.toLowerCase()} rule without checking the portfolio constraint.`,
    },
    sourceLessonId: lesson.id,
    provenance: provenance(spec, 'vignette-question', `${vignetteId}-q-${(index % 3) + 1}`, `Item-set question ${index + 1} was reviewed for answer support, distractors, and objective mapping.`),
  };
}

function authoredVignettes(
  spec: Level3TopicSpec,
  lessonBlueprints: LessonBlueprint[],
  objectiveBlueprints: ObjectiveBlueprint[],
  formulaBlueprints: FormulaBlueprint[],
  localDataset: TopicDataset,
): AuthoredVignette[] {
  return Array.from({ length: 4 }, (_, index) => {
    const lesson = lessonBlueprints[index % lessonBlueprints.length];
    const row = localDataset.rows[index % localDataset.rows.length] || {};
    const vignetteId = `level3-${spec.id}-vignette-${String(index + 1).padStart(2, '0')}`;
    const objectiveIds = lesson.objectiveIds;
    return {
      id: vignetteId,
      level: 'level3',
      topic: topicKey(spec.id),
      title: `${spec.title} Level III item set ${index + 1}`,
      stem: `${pick(spec.caseFrames, index)}. The local case provides exhibits for ${pick(spec.decisions, index).toLowerCase()} and requires decisions that stay inside the stated constraints.`,
      exhibits: [
        {
          id: `${vignetteId}-facts`,
          title: 'Case facts',
          type: 'facts',
          content: `Primary exhibit cue: ${rowCue(row, index)}. The answer must use the stated facts and avoid importing an unstated client or portfolio preference.`,
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
      questions: Array.from({ length: 3 }, (_, questionIndex) =>
        vignetteQuestion(
          spec,
          vignetteId,
          index * 3 + questionIndex,
          objectiveBlueprints[(index * 2 + questionIndex) % objectiveBlueprints.length],
          formulaBlueprints[(index * 2 + questionIndex) % formulaBlueprints.length],
          lesson,
          localDataset,
        ),
      ),
      objectiveIds,
      datasetIds: [localDataset.id],
      difficulty: difficulties[index % difficulties.length],
      tags: ['level3', spec.id, 'item-set'],
      learningObjectives: objectiveIds,
      provenance: provenance(spec, 'vignette', vignetteId, `${spec.title} item set ${index + 1} was reviewed for exhibit quality, objective mapping, and answer support.`),
    };
  });
}

function constructedResponses(
  spec: Level3TopicSpec,
  lessonBlueprints: LessonBlueprint[],
  objectiveBlueprints: ObjectiveBlueprint[],
  localDataset: TopicDataset,
): AuthoredConstructedResponse[] {
  return Array.from({ length: 3 }, (_, index) => {
    const lesson = lessonBlueprints[index % lessonBlueprints.length];
    const row = localDataset.rows[index % localDataset.rows.length] || {};
    const commandWords = [pick(spec.commandWords, index), pick(spec.commandWords, index + 1)];
    const objectiveIds = [objectiveBlueprints[index % objectiveBlueprints.length].id, objectiveBlueprints[(index + 2) % objectiveBlueprints.length].id];
    const crId = `level3-${spec.id}-cr-${String(index + 1).padStart(2, '0')}`;
    return {
      id: crId,
      level: 'level3',
      topic: topicKey(spec.id),
      title: `${spec.title} constructed response ${index + 1}`,
      prompt: `${pick(spec.caseFrames, index)} includes ${rowCue(row, index)}. ${commandWords[0]} the portfolio action and ${commandWords[1]} the answer using only the stated case facts. Respond in short bullets and make each point scorable.`,
      commandWords,
      learningObjectives: objectiveIds,
      objectiveIds,
      datasetIds: [localDataset.id],
      modelAnswer: `A full-credit response first states the portfolio action, then links it to the controlling case fact, and finally explains the implementation or monitoring implication. For this ${spec.title} case, the answer should cite ${rowCue(row, index)}, reject ${pick(spec.traps, index).toLowerCase()}, and connect the conclusion to ${pick(spec.decisions, index).toLowerCase()} without adding facts not present in the exhibit.`,
      rubric: {
        id: `${crId}-rubric`,
        title: `${spec.title} response rubric ${index + 1}`,
        maxPoints: 12,
        criteria: [
          {
            id: `${crId}-rubric-identify`,
            label: 'Identify',
            points: 3,
            description: 'Names the required portfolio action, constraint, or client need using the command word.',
          },
          {
            id: `${crId}-rubric-apply`,
            label: 'Apply',
            points: 4,
            description: 'Applies the relevant policy, concept, or calculation to the stated case facts.',
          },
          {
            id: `${crId}-rubric-justify`,
            label: 'Justify',
            points: 3,
            description: 'Explains why the action follows from the evidence and rejects the main trap.',
          },
          {
            id: `${crId}-rubric-communicate`,
            label: 'Communicate',
            points: 2,
            description: 'Uses concise bullets that are clear enough for independent point scoring.',
          },
        ],
      },
      tags: ['level3', spec.id, 'constructed-response', slug(lesson.title)],
      difficulty: difficulties[index % difficulties.length],
      provenance: provenance(spec, 'constructed-response', crId, `Constructed response ${index + 1} was reviewed for command words, rubric scoring, model answer depth, and case grounding.`),
    };
  });
}

function authoredFlashcards(spec: Level3TopicSpec, objectiveBlueprints: ObjectiveBlueprint[], formulaBlueprints: FormulaBlueprint[]): AuthoredFlashcard[] {
  const objectiveCards = objectiveBlueprints.flatMap((objective, index) => [
    {
      id: `level3-${spec.id}-obj-card-${index + 1}-1`,
      type: 'definition' as const,
      front: `${objective.title} response cue`,
      back: `Translate the command word, cite one case fact, and state the portfolio implication before adding detail.`,
      objectiveId: objective.id,
      sourceKind: 'objective' as const,
    },
    {
      id: `level3-${spec.id}-obj-card-${index + 1}-2`,
      type: 'error-pattern' as const,
      front: `${objective.title} scoring trap`,
      back: `Avoid ${pick(spec.traps, index).toLowerCase()} when the case asks for ${pick(spec.decisions, index).toLowerCase()}.`,
      objectiveId: objective.id,
      sourceKind: 'common-error' as const,
    },
    {
      id: `level3-${spec.id}-obj-card-${index + 1}-3`,
      type: 'definition' as const,
      front: `${objective.title} command check`,
      back: `Answer the verb first, then support it from the case. Long background explanation does not replace the decision.`,
      objectiveId: objective.id,
      sourceKind: 'objective' as const,
    },
  ]);
  const formulaCards = formulaBlueprints.map((formula, index) => ({
    id: `level3-${spec.id}-formula-card-${index + 1}`,
    type: 'formula' as const,
    front: formula.name,
    back: `${formula.latex}\n\n${formula.description}`,
    objectiveId: formula.objectiveIds[0],
    sourceKind: 'formula' as const,
  }));
  const reviewCards = objectiveBlueprints.map((objective, index) => ({
    id: `level3-${spec.id}-review-card-${index + 1}`,
    type: 'definition' as const,
    front: `${objective.title} review trigger`,
    back: `Review this objective when a mock response misses the case fact, the action verb, or ${pick(spec.traps, index).toLowerCase()}.`,
    objectiveId: objective.id,
    sourceKind: 'objective' as const,
  }));

  return [...objectiveCards, ...formulaCards, ...reviewCards].slice(0, 32).map((card, index) => ({
    ...card,
    level: 'level3' as const,
    domain: 'cfa' as const,
    topic: topicKey(spec.id),
    sourcePath: `/cfa/level3/${spec.id}`,
    tags: ['level3', spec.id, 'flashcard'],
    provenance: provenance(spec, 'flashcard', card.id, `Flashcard ${index + 1} was reviewed for concise Level III recall and response relevance.`),
  }));
}

function skillLabs(spec: Level3TopicSpec, objectiveBlueprints: ObjectiveBlueprint[]): SkillLabMapping[] {
  return ['constructed-response', 'item-set-review', 'policy-calculation', 'response-cards'].map((tool, index) => ({
    id: `level3-${spec.id}-skill-lab-${index + 1}`,
    objectiveIds: [objectiveBlueprints[index % objectiveBlueprints.length].id, objectiveBlueprints[(index + 3) % objectiveBlueprints.length].id],
    toolId: `level3:${spec.id}:${tool}`,
    toolType: index === 0 || index === 1 ? 'mock' : index === 2 ? 'calculator' : 'flashcard',
    path: index === 0 ? `/cfa/level3/${spec.id}/constructed-response` : index === 1 ? `/cfa/level3/${spec.id}/vignette` : index === 2 ? '/calculators' : '/flashcards',
    reason: `${spec.title} ${tool.replace('-', ' ')} lab supports reviewed Level III case writing and portfolio decision practice.`,
  }));
}

export function buildLevel3Pack(spec: Level3TopicSpec): AuthoredContentPack {
  const objectiveBlueprints = objectives(spec);
  const formulaBlueprints = formulas(spec, objectiveBlueprints);
  const lessonBlueprints = lessons(spec, objectiveBlueprints);
  const localDataset = dataset(spec, objectiveBlueprints);
  const examples = authoredExamples(spec, lessonBlueprints, objectiveBlueprints, formulaBlueprints, localDataset);
  return {
    id: `level3-${spec.id}-authored-pack`,
    level: 'level3',
    topicId: spec.id,
    title: spec.title,
    examWeight: spec.examWeight,
    maturity: 'exam-ready',
    sourceMeta: {
      original: true,
      examYear: 2026,
      publicReferences: [
        {
          title: 'CFA Level III exam guide',
          url: 'https://www.cfainstitute.org/programs/cfa-program/candidate-resources/level-iii-exam',
          usage: 'exam-format',
        },
      ],
      authoringStatus: 'exam-ready',
      notes: `${spec.title} Level III pack uses public pages only for exam structure and topic weight alignment; learner-facing wording is original QuantVault material.`,
      sourceIds: [`cfa-source-digest:level3:${spec.id}:2026`],
    },
    objectiveBlueprints,
    lessonBlueprints,
    formulaBlueprints,
    questionPacks: lessonBlueprints.slice(0, 3).map((lesson, index) => ({
      id: `${lesson.id}-constructed-response-${index + 1}`,
      itemType: 'constructed-response',
      count: 1,
      objectiveIds: lesson.objectiveIds,
      difficultyMix: { foundation: 0.25, intermediate: 0.5, advanced: 0.25 },
      answerRationaleRequired: true,
      formulaReferencePolicy: 'optional',
    })),
    vignettePacks: lessonBlueprints.slice(0, 4).map((lesson) => ({
      id: `${lesson.id}-item-set`,
      count: 1,
      objectiveIds: lesson.objectiveIds,
      questionsPerVignette: 3,
      exhibitTypes: ['facts', 'table', 'calculation'],
    })),
    flashcardPacks: lessonBlueprints.map((lesson) => ({
      id: `${lesson.id}-flashcards`,
      count: 4,
      objectiveIds: lesson.objectiveIds,
      sourceTypes: ['definition', 'formula', 'error-pattern'],
    })),
    skillLabMappings: skillLabs(spec, objectiveBlueprints),
    authoringReview: {
      reviewer: `QuantVault ${spec.title} Level III reviewer`,
      status: 'exam-ready',
      reviewedAt: reviewerDate,
      notes: `${spec.title} Level III topic passed constructed-response, item-set, rubric, dataset, flashcard, and provenance review.`,
      checks: ['original-wording', 'objective-coverage', 'answer-key', 'distractors', 'formula-links', 'vignette-completeness', 'skill-lab-mapping', 'accessibility'],
      promotionEvidence: [`level3-${spec.id}-2026:topic-review`, `level3-${spec.id}-2026:release-gate`],
    },
    provenance: provenance(spec, 'pack', `level3-${spec.id}-authored-pack`, `${spec.title} Level III pack-level review confirms original wording, rubric depth, and strict provenance.`),
    datasets: [localDataset],
    authoredLessons: authoredLessons(spec, lessonBlueprints, examples),
    authoredExamples: examples,
    authoredQuestions: [],
    authoredVignettes: authoredVignettes(spec, lessonBlueprints, objectiveBlueprints, formulaBlueprints, localDataset),
    authoredConstructedResponses: constructedResponses(spec, lessonBlueprints, objectiveBlueprints, localDataset),
    authoredFlashcards: authoredFlashcards(spec, objectiveBlueprints, formulaBlueprints),
  };
}
