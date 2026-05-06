export type DomainId = 'cfa' | 'quant' | 'excel';

export type Difficulty = 'foundation' | 'intermediate' | 'advanced';

export type Confidence = 'low' | 'medium' | 'high';

export type ErrorCategory =
  | 'concept'
  | 'calculation'
  | 'formula'
  | 'ethics-judgment'
  | 'misread'
  | 'time-pressure'
  | 'none';

export type StudySessionMode =
  | 'reading'
  | 'quiz'
  | 'review'
  | 'formula-drill'
  | 'flashcard-drill'
  | 'mock-section'
  | 'mock-review'
  | 'calculator-drill'
  | 'quant-lab'
  | 'excel-drill'
  | string;

export interface Formula {
  name: string;
  latex: string;
  description: string;
}

export interface LessonSection {
  title: string;
  content: string;
  keyPoints?: string[];
}

export interface LearningObjective {
  id: string;
  domain: DomainId;
  topic: string;
  title: string;
  description: string;
  weight?: string;
  tags: string[];
}

export interface Question {
  id: string;
  topic: string;
  learningObjective: string;
  question: string;
  options: string[];
  correct: number;
  explanation: string;
  difficulty: Difficulty;
  tags: string[];
  errorCategories: ErrorCategory[];
  formula?: string;
  level?: string;
  itemType?: string;
  answerRationale?: {
    correct: string;
    distractors: string[];
    examTrap: string;
  };
  numericTolerance?: number;
}

export interface LearningEvent {
  id?: number;
  domain: DomainId;
  level?: string;
  topic: string;
  mode: StudySessionMode;
  sourceId?: string;
  sourceType:
    | 'lesson'
    | 'question'
    | 'quiz'
    | 'vignette'
    | 'constructed-response'
    | 'formula-drill'
    | 'mock'
    | 'flashcard'
    | 'skill-lab'
    | 'artifact';
  score?: number;
  total?: number;
  elapsedSeconds?: number;
  createdAt: string;
}

export interface LearningEventEnvelope<TPayload = unknown> {
  id: string;
  schemaVersion: 1;
  event: LearningEvent;
  payload?: TPayload;
  sourceIds: string[];
  recordedAt: string;
}

export type ReviewReason =
  | 'due-review'
  | 'weak-objective'
  | 'missed-question'
  | 'flagged-mock-item'
  | 'rubric-miss'
  | 'stale-topic'
  | 'unfinished-lesson'
  | 'flashcard-decay'
  | 'skill-lab-gap'
  | 'saved-artifact';

export interface QuestionAttempt extends QuestionResult {
  id?: number;
  level?: string;
  itemType?: string;
  selected?: number;
  correctIndex?: number;
  formula?: string;
  path?: string;
  title?: string;
  objectiveTitle?: string;
}

export interface LessonProgress {
  id: string;
  domain: DomainId;
  moduleId: string;
  title: string;
  path: string;
  completed: boolean;
  visitCount: number;
  createdAt: string;
  lastVisitedAt: string;
  completedAt?: string | null;
  updatedAt: string;
}

export interface QuestionResult {
  domain: DomainId;
  topic: string;
  questionId: string;
  learningObjective: string;
  correct: boolean;
  confidence: Confidence;
  errorCategory: ErrorCategory;
  difficulty: Difficulty;
  elapsedSeconds?: number;
  createdAt?: string;
}

export interface ReviewItem {
  id: string;
  domain: DomainId;
  topic: string;
  learningObjective: string;
  title: string;
  path: string;
  intervalDays: number;
  ease: number;
  fsrsDifficulty?: number;
  dueAt: string;
  lastResultAt: string;
  attempts: number;
  correctStreak: number;
  lastCorrect: boolean;
  lastConfidence: Confidence;
  lastErrorCategory: ErrorCategory;
}

export interface QuizAttempt {
  id?: number;
  domain: DomainId;
  topic: string;
  title: string;
  mode?: string;
  score: number;
  total: number;
  pct: number;
  elapsedSeconds: number;
  answers: Array<QuestionResult & { selected?: number; correctIndex?: number }>;
  createdAt: string;
}

export interface MasterySnapshot {
  id: string;
  domain: DomainId;
  topic: string;
  learningObjective: string;
  title: string;
  score: number;
  attempts: number;
  correct: number;
  confidenceScore: number;
  lastAttemptAt: string;
  nextReviewAt?: string;
  trend: 'new' | 'up' | 'flat' | 'down';
}

export interface TopicReadiness {
  id: string;
  domain: DomainId;
  topic: string;
  title: string;
  readinessScore: number;
  averageMastery: number;
  volatility: number;
  retentionDecay: number;
  reviewDebt: number;
  confidenceCalibration: number;
  attempts: number;
  dueCount: number;
  trend: 'new' | 'up' | 'flat' | 'down';
}

export interface ObjectiveReadiness {
  id: string;
  domain: DomainId;
  level?: string;
  topic: string;
  learningObjective: string;
  title: string;
  readinessScore: number;
  masteryScore: number;
  attempts: number;
  dueAt?: string;
  trend: 'new' | 'up' | 'flat' | 'down';
}

export interface ObjectiveReadinessV2 extends ObjectiveReadiness {
  readinessVersion: 2;
  itemTypeWeight: number;
  itemTypeAdjustedScore: number;
  topicWeight: number;
  retentionForecastPct?: number;
  evidenceCount: number;
  primaryReason: ReviewReason;
  reasonDetails: string[];
  weaknessSignals: Array<{
    type: 'item-type' | 'rubric' | 'artifact' | 'retention' | 'topic-weight' | 'calibration';
    label: string;
    impact: number;
  }>;
}

export interface RetentionForecast {
  date: string;
  count: number;
  averageRetention: number | null;
  atRiskCount: number;
}

export interface StudyPlan {
  id: string;
  targetLevel?: string;
  dailyTargetMinutes: number;
  examDate?: string | null;
  restDays?: number[];
  mockCadenceDays?: number;
  topicWeights?: Record<string, number>;
  daysToExam?: number | null;
  dueToday: number;
  forecastReviewCount: number;
  nextActions: Array<{
    label: string;
    title: string;
    path: string;
    reason: string;
    reasonDetails?: string[];
    reviewReason?: ReviewReason;
    estimatedMinutes?: number;
  }>;
  updatedAt: string;
}

export interface StudySessionPlan extends StudyPlan {
  planVersion: 2;
  generatedForDate: string;
  focusLevel: string;
  budgetMinutes: number;
  reviewLoad: RetentionForecast[];
}

export interface StudyPlanSettings {
  id: 'local-study-plan';
  targetLevel?: string;
  dailyTargetMinutes: number;
  examDate?: string | null;
  restDays: number[];
  mockCadenceDays?: number;
  topicWeights?: Record<string, number>;
  updatedAt: string;
}

export interface ReviewQueueItem {
  id: string;
  type:
    | 'due-review'
    | 'weak-objective'
    | 'missed-question'
    | 'bookmark'
    | 'stale-topic'
    | 'unfinished-lesson'
    | 'mock-review'
    | 'flashcard-review';
  title: string;
  subtitle: string;
  path: string;
  priority: number;
  dueAt?: string;
  topic?: string;
  reason: ReviewReason;
  retentionPct?: number;
  sourceIds?: string[];
  reasonDetails?: string[];
  weaknessSignals?: Array<{ label: string; impact: number }>;
}

export type ReviewAction = ReviewQueueItem;

export interface MockAttempt {
  id?: number;
  domain: DomainId;
  level: string;
  title: string;
  mode: 'mock-exam' | 'mock-section';
  score: number;
  total: number;
  pct: number;
  elapsedSeconds: number;
  flaggedQuestionIds: string[];
  topicBreakdown: Array<{ topic: string; score: number; total: number; pct: number }>;
  answers: Array<QuestionResult & { selected?: number; correctIndex?: number }>;
  createdAt: string;
}

export interface VignetteAttempt {
  id?: number;
  domain: DomainId;
  level: string;
  topic: string;
  vignetteId: string;
  title: string;
  score: number;
  total: number;
  pct: number;
  elapsedSeconds: number;
  answers: Array<QuestionResult & { selected?: number; correctIndex?: number }>;
  createdAt: string;
}

export interface ConstructedResponseAttempt {
  id?: number;
  domain: DomainId;
  level: string;
  topic: string;
  itemId: string;
  title: string;
  earnedPoints: number;
  maxPoints: number;
  pct: number;
  rubricScores: Record<string, number>;
  response: string;
  elapsedSeconds: number;
  createdAt: string;
}

export interface FormulaDrillAttempt {
  id?: number;
  domain: DomainId;
  level?: string;
  topic: string;
  formulaName: string;
  correct: boolean;
  confidence: Confidence;
  elapsedSeconds: number;
  createdAt: string;
}

export interface SkillLabAttempt {
  id?: number;
  domain: DomainId;
  level?: string;
  topic: string;
  labId: string;
  labType: 'calculator' | 'quant-lab' | 'excel-drill' | 'formula-drill';
  objectiveIds: string[];
  artifactId?: string;
  score?: number;
  elapsedSeconds: number;
  createdAt: string;
}

export interface StudySession {
  id?: number;
  domain: DomainId;
  topic: string;
  mode: StudySessionMode;
  startedAt: string;
  endedAt: string;
  elapsedSeconds: number;
  questionsAnswered: number;
  score: number;
}

export interface ReviewEvent {
  id?: number;
  domain: DomainId;
  topic: string;
  learningObjective: string;
  eventType: 'scheduled' | 'rescheduled' | 'completed' | 'lapsed';
  reviewItemId?: string;
  dueAt?: string;
  createdAt: string;
}

export interface ConfidenceCalibration {
  id?: number;
  domain: DomainId;
  topic: string;
  learningObjective?: string;
  questionId?: string;
  confidence: Confidence;
  correct: boolean;
  createdAt: string;
}

export interface FlashcardAttempt {
  id?: number;
  domain: DomainId;
  topic: string;
  cardId: string;
  cardType: 'formula' | 'definition' | 'error-pattern' | 'bookmark';
  outcome: 'again' | 'known';
  elapsedSeconds: number;
  createdAt: string;
}

export interface ResultArtifact {
  id: string;
  type: 'calculator' | 'quant-lab' | 'excel-grid' | 'mock-report';
  domain?: DomainId;
  level?: string;
  topic?: string;
  title: string;
  summary: string;
  assumptions: Record<string, string | number | boolean | null>;
  metrics: Record<string, string | number | boolean | null>;
  path?: string;
  noteId?: string;
  objectiveIds?: string[];
  createdAt: string;
}

export interface MockSectionState {
  id: string;
  title: string;
  questionIds: string[];
  selected: Record<string, number>;
  constructedResponses?: Record<string, string>;
  rubricScores?: Record<string, Record<string, number>>;
  flaggedQuestionIds: string[];
  currentIndex: number;
  startTime: number;
  pausedMs: number;
  pausedAt?: number | null;
  status: 'in-progress' | 'paused';
  updatedAt: string;
  expiresAt: string;
}

export interface ContentVersion {
  id: string;
  version: number;
  checksum?: string;
  updatedAt: string;
}

export interface VaultImportHistoryEntry {
  exportId: string;
  importedAt: string;
  exportedAt: string;
  schemaVersion: number;
  schemaHash: string;
  contentVersion: string;
  mode: 'merge' | 'replace';
  conflictPolicy: 'keep-existing' | 'prefer-import' | 'replace';
  encrypted: boolean;
}

export interface VaultHealthSnapshot {
  id: string;
  generatedAt: string;
  status: 'ok' | 'warning' | 'repair-needed';
  totalRows: number;
  malformedRows: number;
  orphanedReviews: number;
  staleIndexes: number;
  checksumIssues: number;
  repairActions: string[];
}

export interface VaultHealthReport extends VaultHealthSnapshot {
  schemaVersion: number;
  schemaHash: string;
  contentVersion: string;
  importHistory: VaultImportHistoryEntry[];
  storageEstimate?: {
    usage?: number;
    quota?: number;
    persisted?: boolean;
  };
}

export interface ConfidenceCalibrationSummary {
  confidence: Confidence;
  attempts: number;
  accuracy: number;
  calibrationGap: number;
}

export interface AnalyticsSummary {
  generatedAt: string;
  totals: {
    questionsAnswered: number;
    sessions: number;
    studyTimeSeconds: number;
    mockAttempts: number;
    vignetteAttempts?: number;
    constructedResponseAttempts?: number;
    skillLabAttempts?: number;
    flashcardAttempts: number;
    artifacts: number;
  };
  byLevel?: Array<{ level: string; attempts: number; accuracy: number }>;
  byObjective?: Array<{ objectiveId: string; topic: string; attempts: number; accuracy: number; recentTrend: 'new' | 'up' | 'flat' | 'down' }>;
  byItemType?: Array<{ itemType: string; attempts: number; accuracy: number }>;
  essayRubrics?: Array<{ criterion: string; attempts: number; averagePct: number }>;
  constructedResponseWeaknesses?: Array<{ criterion: string; attempts: number; averagePct: number; impact: number }>;
  skillLabs?: Array<{ labId: string; labType?: string; attempts: number; latestScore?: number; impactedObjectives: number; impact: number }>;
  objectiveImpacts?: Array<{ objectiveId: string; topic?: string; sourceType: string; attempts: number; averageScore: number; impact: number }>;
  byTopic: Array<{
    topic: string;
    attempts: number;
    accuracy: number;
    averageConfidence: number;
    averageElapsedSeconds: number;
    formulaDependency: number;
    timePressureErrors: number;
    recentTrend: 'new' | 'up' | 'flat' | 'down';
  }>;
  byDifficulty: Array<{ difficulty: Difficulty; attempts: number; accuracy: number }>;
  byErrorCategory: Array<{ errorCategory: ErrorCategory; attempts: number }>;
  confidenceCalibration: ConfidenceCalibrationSummary[];
  rollingTrend: Array<{ date: string; attempts: number; accuracy: number }>;
}

export interface VaultNote {
  id: string;
  type: 'lesson' | 'formula' | 'question' | 'general' | 'artifact';
  domain?: DomainId;
  moduleId?: string;
  questionId?: string;
  formulaName?: string;
  title: string;
  body: string;
  path?: string;
  artifactId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultBookmark {
  id: string;
  type: 'lesson' | 'formula' | 'question';
  domain?: DomainId;
  moduleId?: string;
  questionId?: string;
  formulaName?: string;
  title: string;
  path: string;
  createdAt: string;
}
