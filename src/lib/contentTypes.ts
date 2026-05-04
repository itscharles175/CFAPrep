import type { Difficulty, DomainId, ErrorCategory, Formula, LearningObjective, LessonSection, Question } from './learningTypes';

export type ContentMaturity = 'stub' | 'draft' | 'validated' | 'exam-ready';

export type ContentRuntimeMode = 'generated' | 'validated-beta' | 'exam-ready';

export type EditorialStatus = 'template-draft' | 'editorial-draft' | 'validated' | 'exam-ready';

export type ContentSourceKind =
  | 'template-spec'
  | 'editorial-authoring'
  | 'expert-review'
  | 'public-structure'
  | 'local-dataset';

export interface ContentProvenance {
  author: string;
  reviewer: string;
  reviewedAt: string;
  sourceKind: ContentSourceKind;
  editorialStatus: EditorialStatus;
  qualityNotes: string;
  generatedFromTemplate: boolean;
}

export type ItemType =
  | 'single'
  | 'vignette'
  | 'formula-drill'
  | 'definition-drill'
  | 'calculation'
  | 'ethics-case'
  | 'constructed-response'
  | 'mock-section';

export interface ContentSourceMeta {
  original: boolean;
  curriculumMap: string;
  authoringStatus: ContentMaturity;
  reviewedAt?: string;
  runtimeMode?: ContentRuntimeMode;
  runtimeLabel?: string;
}

export interface CurriculumSourceReference {
  title: string;
  url: string;
  usage: 'topic-weights' | 'exam-format' | 'public-structure' | 'errata-check';
}

export interface CurriculumSourceMeta {
  original: true;
  examYear: number;
  publicReferences: CurriculumSourceReference[];
  authoringStatus: ContentMaturity;
  notes: string;
  runtimeMode?: ContentRuntimeMode;
  runtimeLabel?: string;
}

export interface ObjectiveBlueprint {
  id: string;
  title: string;
  description: string;
  skill: 'learn-describe' | 'analyze-evaluate' | 'integrate-apply';
  tags: string[];
  commandWords?: string[];
}

export interface FormulaBlueprint {
  id: string;
  name: string;
  latex: string;
  description: string;
  objectiveIds: string[];
}

export interface AssessmentBlueprint {
  id: string;
  itemType: ItemType;
  scope: 'standalone' | 'mini-vignette' | 'item-set' | 'constructed-response-set' | 'drill';
  count: number;
  objectiveIds: string[];
  difficultyMix: Partial<Record<Difficulty, number>>;
  promptStyle: string;
  notes: string;
  commandWords?: string[];
  rubricBands?: string[];
}

export interface FlashcardBlueprint {
  id: string;
  type: 'formula' | 'definition' | 'error-pattern' | 'bookmark';
  count: number;
  objectiveIds: string[];
  promptStyle: string;
}

export interface SkillLabMapping {
  id: string;
  objectiveIds: string[];
  toolId: string;
  toolType: 'calculator' | 'quant-lab' | 'excel-drill' | 'formula-drill' | 'mock' | 'flashcard';
  path: string;
  reason: string;
}

export interface StudyUnit {
  id: string;
  title: string;
  sequence: number;
  summary: string;
  objectiveIds: string[];
  formulaIds: string[];
  lessonSectionCount: number;
  workedExampleCount: number;
  assessmentBlueprints: AssessmentBlueprint[];
  flashcardBlueprints: FlashcardBlueprint[];
  commonErrors: string[];
}

export interface LessonBlueprint {
  id: string;
  title: string;
  objectiveIds: string[];
  sectionTitles: string[];
  workedExampleTitles: string[];
  commonErrors: string[];
}

export interface QuestionPack {
  id: string;
  itemType: ItemType;
  count: number;
  objectiveIds: string[];
  difficultyMix: Partial<Record<Difficulty, number>>;
  answerRationaleRequired: boolean;
  formulaReferencePolicy: 'required-where-calculation' | 'optional' | 'not-applicable';
}

export interface VignettePack {
  id: string;
  count: number;
  objectiveIds: string[];
  questionsPerVignette: number;
  exhibitTypes: Array<'table' | 'quote' | 'facts' | 'calculation'>;
}

export interface FlashcardPack {
  id: string;
  count: number;
  objectiveIds: string[];
  sourceTypes: Array<'formula' | 'definition' | 'error-pattern' | 'bookmark'>;
}

export interface AuthoringReview {
  reviewer: string;
  status: ContentMaturity;
  reviewedAt: string;
  notes: string;
  checks: Array<
    | 'original-wording'
    | 'objective-coverage'
    | 'answer-key'
    | 'distractors'
    | 'formula-links'
    | 'vignette-completeness'
    | 'skill-lab-mapping'
    | 'accessibility'
  >;
}

export interface ContentPack {
  id: string;
  level: CurriculumLevel['id'];
  topicId: string;
  title: string;
  examWeight: string;
  maturity: ContentMaturity;
  sourceMeta: CurriculumSourceMeta;
  objectiveBlueprints: ObjectiveBlueprint[];
  lessonBlueprints: LessonBlueprint[];
  formulaBlueprints: FormulaBlueprint[];
  questionPacks: QuestionPack[];
  vignettePacks: VignettePack[];
  flashcardPacks: FlashcardPack[];
  skillLabMappings: SkillLabMapping[];
  authoringReview: AuthoringReview;
}

export interface CfaContentBatch {
  id: string;
  title: string;
  sequence: number;
  level: CurriculumLevel['id'];
  topicIds: string[];
  maturity: ContentMaturity;
  packs: ContentPack[];
  acceptanceCriteria: string[];
}

export interface TopicDataset {
  id: string;
  title: string;
  description: string;
  objectiveIds: string[];
  columns: string[];
  rows: Array<Record<string, string | number>>;
  tags: string[];
  provenance: ContentProvenance;
}

export interface AuthoredLesson {
  id: string;
  title: string;
  objectiveIds: string[];
  formulaIds: string[];
  sections: LessonSection[];
  examples: ReadingExample[];
  commonErrors: string[];
  keyTakeaways: string[];
  provenance: ContentProvenance;
}

export interface AuthoredExample extends ReadingExample {
  lessonId: string;
  objectiveId: string;
  datasetId?: string;
  provenance: ContentProvenance;
}

export interface AuthoredQuestion extends Question {
  level: CurriculumLevel['id'];
  topic: string;
  itemType: ItemType;
  options: [string, string, string];
  answerRationale: AnswerRationale;
  errorCategories: ErrorCategory[];
  sourceLessonId?: string;
  provenance: ContentProvenance;
}

export interface AuthoredVignette extends Omit<Vignette, 'questions' | 'exhibits' | 'level'> {
  level: CurriculumLevel['id'];
  exhibits: VignetteExhibit[];
  questions: AuthoredQuestion[];
  objectiveIds: string[];
  datasetIds: string[];
  provenance: ContentProvenance;
}

export interface AuthoredFlashcard extends Flashcard {
  level: CurriculumLevel['id'];
  objectiveId: string;
  sourceKind: 'objective' | 'formula' | 'common-error' | 'example' | 'vignette';
  provenance: ContentProvenance;
}

export interface AuthoredContentPack extends ContentPack {
  provenance: ContentProvenance;
  datasets: TopicDataset[];
  authoredLessons: AuthoredLesson[];
  authoredExamples: AuthoredExample[];
  authoredQuestions: AuthoredQuestion[];
  authoredVignettes: AuthoredVignette[];
  authoredFlashcards: AuthoredFlashcard[];
}

export interface ContentPackRelease {
  id: string;
  level: CurriculumLevel['id'];
  status: ContentMaturity;
  generatedAt: string;
  topicIds: string[];
  packIds: string[];
  blockingIssues: number;
  warnings: number;
  notes: string[];
}

export interface ContentBatchProgress {
  id: string;
  level: CurriculumLevel['id'];
  title: string;
  topicCount: number;
  examReadyTopics: number;
  validatedTopics: number;
  draftTopics: number;
  totalObjectives: number;
  totalLessons: number;
  totalExamples: number;
  totalQuestions: number;
  totalVignettes: number;
  totalFlashcards: number;
  totalSkillLabs: number;
  releaseBlocked: boolean;
}

export interface RuntimeContentStatus {
  level: string;
  mode: ContentRuntimeMode;
  label: string;
  releaseEligible: boolean;
  topicCount: number;
  authoredPackCount: number;
  validatedTopics: number;
  examReadyTopics: number;
  blockers: string[];
  warnings: string[];
}

export interface ContentRuntimeReport {
  generatedAt: string;
  levels: RuntimeContentStatus[];
}

export interface CurriculumTopic {
  id: string;
  title: string;
  examWeight: string;
  maturity: ContentMaturity;
  pathway?: 'core' | 'portfolio-management' | 'private-wealth' | 'private-markets';
  sourceMeta: CurriculumSourceMeta;
  objectiveBlueprints: ObjectiveBlueprint[];
  formulaBlueprints: FormulaBlueprint[];
  studyUnits: StudyUnit[];
  skillLabMappings: SkillLabMapping[];
}

export interface CurriculumLevel {
  id: 'level1' | 'level2' | 'level3';
  title: string;
  examFormat: string;
  examWeightNotes: string;
  topics: CurriculumTopic[];
}

export interface CurriculumMap {
  id: string;
  examYear: number;
  title: string;
  sourceMeta: CurriculumSourceMeta;
  levels: CurriculumLevel[];
}

export interface CurriculumCoverageReport {
  generatedAt: string;
  examYear: number;
  level?: string;
  topics: Array<{
    id: string;
    title: string;
    level: string;
    maturity: ContentMaturity;
    studyUnits: number;
    lessonSections: number;
    objectives: number;
    formulas: number;
    standaloneQuestions: number;
    vignettes: number;
    constructedResponses: number;
    flashcards: number;
    skillLabs: number;
  }>;
  totals: {
    levels: number;
    topics: number;
    examReadyTopics: number;
    studyUnits: number;
    lessonSections: number;
    objectives: number;
    formulas: number;
    standaloneQuestions: number;
    vignettes: number;
    constructedResponses: number;
    flashcards: number;
    skillLabs: number;
    errors: number;
    warnings: number;
  };
  issues: Array<{ severity: 'error' | 'warning'; area: string; id: string; message: string }>;
}

export interface ReadingExample {
  id: string;
  topic: string;
  learningObjective: string;
  title: string;
  prompt: string;
  walkthrough: string;
  formulaName?: string;
  tags: string[];
}

export interface AnswerRationale {
  correct: string;
  distractors: string[];
  examTrap: string;
}

export interface VignetteExhibit {
  id: string;
  title: string;
  type: 'table' | 'quote' | 'facts' | 'calculation';
  content: string;
  sourceObjectiveIds: string[];
}

export interface Course {
  id: string;
  domain: DomainId;
  title: string;
  levels: Level[];
  version: number;
}

export interface Level {
  id: string;
  title: string;
  topics: Topic[];
}

export interface Topic {
  id: string;
  title: string;
  weight?: string;
  maturity?: ContentMaturity;
  readings: Reading[];
  learningObjectives: LearningObjective[];
  formulas: Formula[];
  questions: Question[];
  vignettes?: Vignette[];
  flashcards?: Flashcard[];
  skillLabs?: SkillLab[];
  sourceMeta?: ContentSourceMeta;
}

export interface Reading {
  id: string;
  topic: string;
  title: string;
  sections: LessonSection[];
  formulas: Formula[];
  examples?: ReadingExample[];
}

/** @deprecated Use ReadingExample for new content bundles. */
export interface Example {
  id: string;
  topic: string;
  title: string;
  prompt: string;
  walkthrough: string;
  formulaName?: string;
  tags: string[];
}

export interface Vignette {
  id: string;
  topic: string;
  title: string;
  stem: string;
  exhibits?: VignetteExhibit[];
  questions: Question[];
  difficulty: Difficulty;
  tags: string[];
  learningObjectives?: string[];
  level?: string;
}

export interface MockExam {
  id: string;
  level: string;
  title: string;
  durationMinutes: number;
  questionIds: string[];
  topics: string[];
  vignetteIds?: string[];
  constructedResponseIds?: string[];
  itemTypes?: ItemType[];
}

export interface Rubric {
  id: string;
  title: string;
  maxPoints: number;
  criteria: Array<{
    id: string;
    label: string;
    points: number;
    description: string;
  }>;
}

export interface ConstructedResponseItem {
  id: string;
  level: string;
  topic: string;
  title: string;
  prompt: string;
  commandWords: string[];
  learningObjectives: string[];
  modelAnswer: string;
  rubric: Rubric;
  tags: string[];
  difficulty: Difficulty;
}

export interface Flashcard {
  id: string;
  domain: DomainId;
  topic: string;
  type: 'formula' | 'definition' | 'error-pattern' | 'bookmark';
  front: string;
  back: string;
  sourcePath: string;
  tags: string[];
}

export interface ObjectiveToolMapping {
  objectiveId: string;
  toolId: string;
  toolType: 'calculator' | 'quant-lab' | 'excel-drill' | 'formula-drill' | 'mock' | 'flashcard';
  path: string;
  reason: string;
}

export interface SkillLab {
  id: string;
  title: string;
  domain: DomainId;
  topic: string;
  type: 'calculator' | 'quant-lab' | 'excel-drill' | 'formula-drill';
  path: string;
  objectiveIds: string[];
  artifactType: 'calculator' | 'quant-lab' | 'excel-grid' | 'mock-report';
  description: string;
}

export interface CfaTopicContent extends Topic {
  level: string;
  topic: string;
  runtimeMode?: ContentRuntimeMode;
  runtimeLabel?: string;
  sections: LessonSection[];
  examples: ReadingExample[];
  vignettes: Vignette[];
  constructedResponses: ConstructedResponseItem[];
  flashcards: Flashcard[];
  skillLabs: SkillLab[];
  toolMappings: ObjectiveToolMapping[];
  sourceMeta: ContentSourceMeta;
}

export interface CfaLevelContent {
  id: string;
  title: string;
  examFormat: string;
  summary: string;
  runtimeMode?: ContentRuntimeMode;
  runtimeLabel?: string;
  topics: CfaTopicContent[];
  mockExams: MockExam[];
  constructedResponses: ConstructedResponseItem[];
  sourceMeta: ContentSourceMeta;
}

export interface ContentCoverageReport {
  generatedAt: string;
  courseVersion: number;
  level?: string;
  topics: Array<{
    id: string;
    title: string;
    level?: string;
    maturity?: ContentMaturity;
    readings: number;
    sections: number;
    examples?: number;
    objectives: number;
    formulas: number;
    questions: number;
    vignettes: number;
    flashcards?: number;
    skillLabs?: number;
    constructedResponses?: number;
    readinessCoverage: number;
  }>;
  totals: {
    levels?: number;
    topics: number;
    objectives: number;
    formulas: number;
    questions: number;
    vignettes: number;
    flashcards?: number;
    skillLabs?: number;
    constructedResponses?: number;
    errors: number;
    warnings: number;
  };
  issues: Array<{ severity: 'error' | 'warning'; area: string; id: string; message: string }>;
}
