import { excelModules, formulaLibrary, quantModules } from '../data/catalog';
import { excelContent } from '../data/excelContent';
import { quantContent } from '../data/quantContent';
import {
  cfaAllQuestions,
  cfaAllSkillLabs,
  cfaLevelContent as rawCfaLevelContent,
  getCfaLevelContent,
  getCfaMockExam,
} from '../domains/cfa/cfaLevels';
import type { ContentCoverageReport, Course, CfaLevelContent, CfaTopicContent, MockExam } from './contentTypes';

const quantContentById = quantContent as Record<string, any>;
const excelContentById = excelContent as Record<string, any>;
const allCfaLevelContent = rawCfaLevelContent as unknown as CfaLevelContent[];

export interface ContentValidationIssue {
  severity: 'error' | 'warning';
  area: string;
  id: string;
  message: string;
}

const levelTargets = {
  level1: { objectives: 8, sections: 12, formulas: 10, questions: 80, vignettes: 6, flashcards: 80, skillLabs: 1 },
  level2: { objectives: 8, sections: 10, formulas: 8, questions: 24, vignettes: 12, flashcards: 40, skillLabs: 1 },
  level3: { objectives: 8, sections: 12, formulas: 6, questions: 12, vignettes: 4, flashcards: 32, skillLabs: 4, constructedResponses: 3 },
} as const;

function selectedLevels(level?: string | null): CfaLevelContent[] {
  return level ? [getCfaLevelContent(level) as CfaLevelContent] : allCfaLevelContent;
}

function topicIssue(
  topic: CfaTopicContent,
  metric: keyof (typeof levelTargets)['level1'] | 'constructedResponses',
  actual: number,
  target: number,
): ContentValidationIssue | null {
  if (actual >= target) return null;
  return {
    severity: topic.maturity === 'exam-ready' ? 'error' : 'warning',
    area: 'content-depth',
    id: `${topic.level}:${topic.id}:${metric}`,
    message: `${topic.title} has ${actual} ${metric}; target is ${target} before exam-ready release.`,
  };
}

export function buildCfaLevel1Course(): Course {
  const level1 = getCfaLevelContent('level1') as CfaLevelContent;
  return {
    id: 'cfa-program',
    domain: 'cfa',
    title: 'CFA Program',
    version: 2,
    levels: [
      {
        id: level1.id,
        title: level1.title,
        topics: level1.topics.map((topic: CfaTopicContent) => ({
          id: topic.id,
          title: topic.title,
          weight: topic.weight,
          maturity: topic.maturity,
          readings: topic.readings,
          learningObjectives: topic.learningObjectives,
          formulas: topic.formulas,
          questions: topic.questions,
          vignettes: topic.vignettes,
          flashcards: topic.flashcards,
          skillLabs: topic.skillLabs,
          sourceMeta: topic.sourceMeta,
        })),
      },
    ],
  };
}

export function validateLevelContent(level?: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];

  selectedLevels(level).forEach((levelContent) => {
    levelContent.topics.forEach((topic) => {
      const target = levelTargets[levelContent.id as keyof typeof levelTargets] || levelTargets.level1;
      if (!topic.sourceMeta?.original) {
        issues.push({
          severity: 'error',
          area: 'source-meta',
          id: `${levelContent.id}:${topic.id}`,
          message: 'CFA topic must be marked as original local content.',
        });
      }
      if (!topic.readings.length) {
        issues.push({ severity: 'error', area: 'catalog', id: `${levelContent.id}:${topic.id}`, message: 'Topic has no readings.' });
      }
      [
        topicIssue(topic, 'objectives', topic.learningObjectives.length, target.objectives),
        topicIssue(topic, 'sections', topic.readings.reduce((sum, reading) => sum + reading.sections.length, 0), target.sections),
        topicIssue(topic, 'formulas', topic.formulas.length, target.formulas),
        topicIssue(topic, 'questions', topic.questions.length + topic.vignettes.reduce((sum, vignette) => sum + vignette.questions.length, 0), target.questions),
        topicIssue(topic, 'vignettes', topic.vignettes.length, target.vignettes),
        topicIssue(topic, 'flashcards', topic.flashcards.length, target.flashcards),
        topicIssue(topic, 'skillLabs', topic.skillLabs.length, target.skillLabs),
        'constructedResponses' in target
          ? topicIssue(topic, 'constructedResponses', topic.constructedResponses.length, target.constructedResponses)
          : null,
      ]
        .filter(Boolean)
        .forEach((issue) => issues.push(issue as ContentValidationIssue));
    });
  });

  quantModules
    .filter((module) => module.status === 'available' && !quantContentById[module.id])
    .forEach((module) => issues.push({ severity: 'error', area: 'quant', id: module.id, message: 'Available quant module has no content.' }));

  excelModules
    .filter((module) => module.status === 'available' && !excelContentById[module.id])
    .forEach((module) => issues.push({ severity: 'error', area: 'excel', id: module.id, message: 'Available Excel module has no content.' }));

  return issues;
}

export function validateContentCatalog(): ContentValidationIssue[] {
  return validateLevelContent('level1');
}

export function validateQuestionBank(level?: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const levels = selectedLevels(level);
  const objectives = new Set(levels.flatMap((item) => item.topics.flatMap((topic) => topic.learningObjectives.map((objective) => objective.id))));
  const questions = levels.flatMap((item) => item.topics.flatMap((topic) => [...topic.questions, ...topic.vignettes.flatMap((vignette) => vignette.questions)]));
  const constructedResponses = levels.flatMap((item) => item.topics.flatMap((topic) => topic.constructedResponses));
  const seenIds = new Set<string>();
  const seenPrompts = new Map<string, string>();
  const countsByObjective = new Map<string, number>();

  questions.forEach((question) => {
    if (seenIds.has(question.id)) {
      issues.push({ severity: 'error', area: 'question-bank', id: question.id, message: 'Duplicate question id.' });
    }
    seenIds.add(question.id);

    const normalizedPrompt = question.question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const priorPrompt = seenPrompts.get(normalizedPrompt);
    if (priorPrompt) {
      issues.push({
        severity: 'warning',
        area: 'question-bank',
        id: question.id,
        message: `Question prompt is very similar to ${priorPrompt}.`,
      });
    }
    seenPrompts.set(normalizedPrompt, question.id);

    if (!objectives.has(question.learningObjective)) {
      issues.push({ severity: 'error', area: 'question-bank', id: question.id, message: 'Question maps to an unknown learning objective.' });
    }
    countsByObjective.set(question.learningObjective, (countsByObjective.get(question.learningObjective) || 0) + 1);
    if (!question.options || question.options.length < 2) {
      issues.push({ severity: 'error', area: 'question-bank', id: question.id, message: 'Question needs at least two answer options.' });
    }
    if (question.correct < 0 || question.correct >= question.options.length) {
      issues.push({ severity: 'error', area: 'question-bank', id: question.id, message: 'Question has an invalid answer key.' });
    }
    if (!question.explanation || question.explanation.length < 45) {
      issues.push({ severity: 'warning', area: 'question-bank', id: question.id, message: 'Question explanation is too thin.' });
    }
    const uniqueOptions = new Set((question.options || []).map((option) => option.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
    if (uniqueOptions.size !== question.options.length) {
      issues.push({ severity: 'warning', area: 'question-bank', id: question.id, message: 'Question answer options should be unique before exam-ready release.' });
    }
    if (question.answerRationale) {
      if (!question.answerRationale.correct || question.answerRationale.distractors.length < Math.max(1, question.options.length - 1)) {
        issues.push({ severity: 'warning', area: 'question-bank', id: question.id, message: 'Answer rationale should explain the correct choice and each distractor.' });
      }
    } else {
      issues.push({ severity: 'warning', area: 'question-bank', id: question.id, message: 'Question has no semantic answer rationale.' });
    }
    if (!question.tags?.length) {
      issues.push({ severity: 'warning', area: 'question-bank', id: question.id, message: 'Question has no tags.' });
    }
    if (!question.errorCategories?.length) {
      issues.push({ severity: 'warning', area: 'question-bank', id: question.id, message: 'Question has no error category options.' });
    }
  });

  constructedResponses.forEach((item) => {
    item.learningObjectives.forEach((objectiveId) => {
      if (objectives.has(objectiveId)) {
        countsByObjective.set(objectiveId, (countsByObjective.get(objectiveId) || 0) + 1);
      }
    });
  });

  objectives.forEach((objectiveId) => {
    if (!countsByObjective.has(objectiveId)) {
      issues.push({
        severity: 'warning',
        area: 'objective-coverage',
        id: objectiveId,
        message: 'Learning objective has no direct question coverage.',
      });
    }
  });

  return issues;
}

export function validateFormulaCoverage(level?: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const levels = selectedLevels(level);
  const formulasByTopic = new Map(
    levels.flatMap((levelContent) =>
      levelContent.topics.map((topic) => [topic.topic, new Set(topic.formulas.map((formula) => formula.name))] as const),
    ),
  );
  const questions = levels.flatMap((item) => item.topics.flatMap((topic) => [...topic.questions, ...topic.vignettes.flatMap((vignette) => vignette.questions)]));

  questions
    .filter((question) => question.formula)
    .forEach((question) => {
      if (!formulasByTopic.get(question.topic)?.has(question.formula as string)) {
        issues.push({
          severity: 'warning',
          area: 'formula-coverage',
          id: question.id,
          message: `Question references formula "${question.formula}" that is not listed on its topic.`,
        });
      }
    });

  formulaLibrary.forEach((formula) => {
    if (!formula.name || !formula.latex) {
      issues.push({ severity: 'error', area: 'formula-library', id: formula.name || formula.category, message: 'Formula library entry is incomplete.' });
    }
  });

  return issues;
}

export function validateVignettes(level?: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  selectedLevels(level).forEach((levelContent) => {
    const objectiveIds = new Set(levelContent.topics.flatMap((topic) => topic.learningObjectives.map((objective) => objective.id)));
    levelContent.topics.flatMap((topic) => topic.vignettes).forEach((vignette) => {
      if (!vignette.stem || vignette.stem.length < 80) {
        issues.push({ severity: 'error', area: 'vignette', id: vignette.id, message: 'Vignette stem is missing or too short.' });
      }
      if (vignette.questions.length < 3) {
        issues.push({ severity: 'error', area: 'vignette', id: vignette.id, message: 'Vignette should include at least three questions.' });
      }
      if (!vignette.exhibits?.length) {
        issues.push({ severity: 'warning', area: 'vignette', id: vignette.id, message: 'Vignette has no structured exhibits.' });
      }
      vignette.exhibits?.forEach((exhibit) => {
        if (!exhibit.title || !exhibit.content || !exhibit.sourceObjectiveIds.length) {
          issues.push({ severity: 'warning', area: 'vignette', id: exhibit.id, message: 'Vignette exhibit is missing title, content, or objective mapping.' });
        }
      });
      vignette.questions.forEach((question) => {
        if (!objectiveIds.has(question.learningObjective)) {
          issues.push({ severity: 'error', area: 'vignette', id: question.id, message: 'Vignette question maps to an unknown objective.' });
        }
      });
    });
  });
  return issues;
}

export function validateConstructedResponses(level?: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  selectedLevels(level).forEach((levelContent) => {
    const objectiveIds = new Set(levelContent.topics.flatMap((topic) => topic.learningObjectives.map((objective) => objective.id)));
    levelContent.topics.flatMap((topic) => topic.constructedResponses).forEach((item) => {
      if (!item.prompt || item.prompt.length < 80) {
        issues.push({ severity: 'error', area: 'constructed-response', id: item.id, message: 'Constructed response prompt is missing or too short.' });
      }
      if (!item.commandWords.length) {
        issues.push({ severity: 'error', area: 'constructed-response', id: item.id, message: 'Constructed response must include command words.' });
      }
      if (!item.modelAnswer || item.modelAnswer.length < 80) {
        issues.push({ severity: 'warning', area: 'constructed-response', id: item.id, message: 'Model answer should be more complete.' });
      }
      const rubricPoints = item.rubric.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
      if (rubricPoints !== item.rubric.maxPoints) {
        issues.push({ severity: 'error', area: 'constructed-response', id: item.id, message: 'Rubric criteria points must equal maxPoints.' });
      }
      item.learningObjectives.forEach((objectiveId) => {
        if (!objectiveIds.has(objectiveId)) {
          issues.push({ severity: 'error', area: 'constructed-response', id: item.id, message: `Unknown mapped objective ${objectiveId}.` });
        }
      });
    });
  });
  return issues;
}

export function validateSkillLabMappings(level?: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  selectedLevels(level).forEach((levelContent) => {
    const objectiveIds = new Set(levelContent.topics.flatMap((topic) => topic.learningObjectives.map((objective) => objective.id)));
    levelContent.topics.forEach((topic) => {
      if (!topic.skillLabs.length) {
        issues.push({ severity: 'error', area: 'skill-lab', id: `${levelContent.id}:${topic.id}`, message: 'Topic has no mapped CFA skill labs.' });
      }
      topic.skillLabs.forEach((lab) => {
        if (!lab.path || !lab.objectiveIds.length) {
          issues.push({ severity: 'error', area: 'skill-lab', id: lab.id, message: 'Skill lab must include a path and mapped objectives.' });
        }
        lab.objectiveIds.forEach((objectiveId) => {
          if (!objectiveIds.has(objectiveId)) {
            issues.push({ severity: 'error', area: 'skill-lab', id: lab.id, message: `Unknown mapped objective ${objectiveId}.` });
          }
        });
      });
    });
  });
  return issues;
}

export function buildLevel1MockExam(): MockExam {
  return getCfaMockExam('level1') as MockExam;
}

export function validateMockExam(mockOrId: MockExam | string = buildLevel1MockExam()): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const mock = typeof mockOrId === 'string'
    ? allCfaLevelContent.flatMap((levelContent) => levelContent.mockExams).find((item: MockExam) => item.id === mockOrId)
    : mockOrId;

  if (!mock) {
    return [{ severity: 'error', area: 'mock-exam', id: String(mockOrId), message: 'Mock exam not found.' }];
  }

  const levelContent = getCfaLevelContent(mock.level) as CfaLevelContent;
  const questionIds = new Set(levelContent.topics.flatMap((topic: CfaTopicContent) => [...topic.questions, ...topic.vignettes.flatMap((vignette) => vignette.questions)].map((question) => question.id)));
  const vignetteIds = new Set(levelContent.topics.flatMap((topic: CfaTopicContent) => topic.vignettes.map((vignette) => vignette.id)));
  const constructedIds = new Set(levelContent.constructedResponses.map((item) => item.id));

  if (!mock.questionIds.length && !mock.vignetteIds?.length && !mock.constructedResponseIds?.length) {
    issues.push({ severity: 'error', area: 'mock-exam', id: mock.id, message: 'Mock exam has no items.' });
  }
  if (mock.durationMinutes <= 0) {
    issues.push({ severity: 'error', area: 'mock-exam', id: mock.id, message: 'Mock exam duration must be positive.' });
  }
  mock.questionIds.forEach((questionId: string) => {
    if (!questionIds.has(questionId)) {
      issues.push({ severity: 'error', area: 'mock-exam', id: questionId, message: 'Mock references an unknown question id.' });
    }
  });
  (mock.vignetteIds || []).forEach((vignetteId: string) => {
    if (!vignetteIds.has(vignetteId)) {
      issues.push({ severity: 'error', area: 'mock-exam', id: vignetteId, message: 'Mock references an unknown vignette id.' });
    }
  });
  (mock.constructedResponseIds || []).forEach((itemId: string) => {
    if (!constructedIds.has(itemId)) {
      issues.push({ severity: 'error', area: 'mock-exam', id: itemId, message: 'Mock references an unknown constructed-response item.' });
    }
  });
  if (new Set(mock.topics).size < Math.min(5, levelContent.topics.length)) {
    issues.push({ severity: 'warning', area: 'mock-exam', id: mock.id, message: 'Mock should span more topics.' });
  }

  return issues;
}

function readinessCoverageScore(topic: CfaTopicContent) {
  const target = levelTargets[topic.level as keyof typeof levelTargets] || levelTargets.level1;
  const numerator =
    Math.min(1, topic.questions.length / target.questions) * 30 +
    Math.min(1, topic.learningObjectives.length / target.objectives) * 20 +
    Math.min(1, topic.formulas.length / target.formulas) * 15 +
    Math.min(1, topic.vignettes.length / target.vignettes) * 15 +
    Math.min(1, topic.flashcards.length / target.flashcards) * 10 +
    Math.min(1, topic.skillLabs.length / target.skillLabs) * 10 +
    ('constructedResponses' in target ? Math.min(1, topic.constructedResponses.length / target.constructedResponses) * 10 : 0);
  return Math.min(100, Math.round(numerator));
}

export function generateCoverageReport(level?: string): ContentCoverageReport {
  const levels = selectedLevels(level);
  const allIssues = [
    ...validateLevelContent(level),
    ...validateQuestionBank(level),
    ...validateFormulaCoverage(level),
    ...validateVignettes(level),
    ...validateConstructedResponses(level),
    ...validateSkillLabMappings(level),
    ...levels.flatMap((levelContent) => levelContent.mockExams.flatMap((mock) => validateMockExam(mock))),
  ];
  const topics = levels.flatMap((levelContent) => levelContent.topics);

  return {
    generatedAt: new Date().toISOString(),
    courseVersion: buildCfaLevel1Course().version,
    level,
    topics: topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      level: topic.level,
      maturity: topic.maturity,
      readings: topic.readings.length,
      sections: topic.readings.reduce((sum, reading) => sum + reading.sections.length, 0),
      examples: topic.examples.length,
      objectives: topic.learningObjectives.length,
      formulas: topic.formulas.length,
      questions: topic.questions.length,
      vignettes: topic.vignettes.length,
      flashcards: topic.flashcards.length,
      skillLabs: topic.skillLabs.length,
      constructedResponses: topic.constructedResponses.length,
      readinessCoverage: readinessCoverageScore(topic),
    })),
    totals: {
      levels: levels.length,
      topics: topics.length,
      objectives: topics.reduce((sum, topic) => sum + topic.learningObjectives.length, 0),
      formulas: topics.reduce((sum, topic) => sum + topic.formulas.length, 0),
      questions: topics.reduce((sum, topic) => sum + topic.questions.length, 0),
      vignettes: topics.reduce((sum, topic) => sum + topic.vignettes.length, 0),
      flashcards: topics.reduce((sum, topic) => sum + topic.flashcards.length, 0),
      skillLabs: cfaAllSkillLabs.length,
      constructedResponses: topics.reduce((sum, topic) => sum + topic.constructedResponses.length, 0),
      errors: allIssues.filter((issue) => issue.severity === 'error').length,
      warnings: allIssues.filter((issue) => issue.severity === 'warning').length,
    },
    issues: allIssues,
  };
}

export function getAllCfaQuestionCount() {
  return cfaAllQuestions.length;
}
