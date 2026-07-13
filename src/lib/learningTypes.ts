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
  // ANL-3 — blind-review capture (append-only, optional). Mirrors the LSAT
  // `Attempt.br_answer`/`br_correct` 2x2 inputs so a host attempt can carry the
  // SAME careless-vs-concept signal. All absent on a row without a BR pass, which
  // simply doesn't contribute to the cross-domain BR gap.
  /** Index chosen on the untimed Blind-Review pass (host index scheme). */
  brAnswer?: number;
  /** Confidence stated on the Blind-Review pass. */
  brConfidence?: Confidence;
  /** Whether the Blind-Review answer was correct — the 2x2's `br_correct` axis. */
  brCorrect?: boolean;
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
  // LEARN-5 — leech + concept-gap unification (append-only). Identity coercion
  // (no bucketing): when a host review card mirrors cross-domain
  // (CrossDomainReviewCard via dataDictionary.ts), these self-describe WHY it is
  // queued so the unified Leeches/Gaps page can rank it next to LSAT rows.
  /** Why the card exists, mirroring the host ReviewReason / LSAT origin vocabulary. */
  origin?: string;
  /** Number of lapses (Again ratings); drives the leech threshold. */
  lapses?: number;
  /** Flagged as a leech (too many lapses) for the remediation queue. */
  leech?: boolean;
  // ANL-3 — blind-review capture (append-only, optional). Carries the most-recent
  // Blind-Review pass on the card's underlying question so the unified
  // careless-vs-concept blind-review analytic (`blindReviewBridge.ts`) can read it
  // alongside LSAT BR data. Absent on a card with no BR pass.
  /** Index chosen on the untimed Blind-Review pass (host index scheme). */
  brAnswer?: number;
  /** Confidence stated on the Blind-Review pass. */
  brConfidence?: Confidence;
  /** Whether the Blind-Review answer was correct — the 2x2's `br_correct` axis. */
  brCorrect?: boolean;
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

export interface VaultSecureCipher {
  v: 1;
  iv: string;
  ct: string;
}

export interface ResultArtifactSecurePayload {
  v: 1;
  scheme: 'secure-vault-result-artifact.v1';
  title: VaultSecureCipher;
  summary: VaultSecureCipher;
  assumptions: VaultSecureCipher;
  metrics: VaultSecureCipher;
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
  secureVault?: ResultArtifactSecurePayload;
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
  secureVault?: {
    enabled: boolean;
    unlocked: boolean;
    available: boolean;
    status: 'disabled' | 'locked' | 'encrypted' | 'partial';
    encryptedRows: number;
    targetRows: number;
    coveragePct: number;
    rows: {
      notes: { encrypted: number; total: number };
      resultArtifacts: { encrypted: number; total: number };
      openNotebookSettings: { encrypted: number; total: number };
      sourceChunks: { encrypted: number; total: number };
    };
    outsideScopeRows: {
      sourceVault: number;
    };
  };
  importHistory: VaultImportHistoryEntry[];
  rollbackSnapshots?: RollbackSnapshot[];
  importJobs?: ImportJob[];
  sourceBundleManifests?: SourceBundleManifest[];
  calculatorScenarios?: CalculatorScenario[];
  releaseRunHistory?: ReleaseRunHistory[];
  storageEstimate?: {
    usage?: number;
    quota?: number;
    persisted?: boolean;
  };
}

export type VaultRollbackReason = 'import-replace' | 'import-merge' | 'repair' | 'reset' | 'source-clear' | 'manual';

export interface RollbackSnapshot {
  id: string;
  reason: VaultRollbackReason;
  createdAt: string;
  schemaVersion: number;
  schemaHash: string;
  contentVersion: string;
  checksum: string;
  encrypted: boolean;
  rowCounts: Record<string, number>;
  sourceRowCounts?: Record<string, number>;
  payload?: unknown;
}

export interface CalculatorScenario {
  id: string;
  calculatorId: string;
  title: string;
  level?: string;
  topic?: string;
  objectiveIds: string[];
  assumptions: Record<string, string | number | boolean | null>;
  metrics: Record<string, string | number | boolean | null>;
  seed?: string;
  sourceIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRunHistory {
  id: string;
  runId: string;
  generatedAt: string;
  status: 'ok' | 'warning' | 'blocked' | 'pending';
  gitSha?: string;
  branch?: string;
  dirty?: boolean;
  gateCount: number;
  failedGateIds: string[];
  staleGateIds: string[];
  reportPath?: string;
}

export interface ImportJob {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: 'pending' | 'ok' | 'blocked';
  mode: 'merge' | 'replace';
  conflictPolicy: 'keep-existing' | 'prefer-import' | 'replace';
  encrypted: boolean;
  includeSourceVault: boolean;
  exportId?: string;
  rowCounts: Record<string, number>;
  sourceRowCounts?: Record<string, number>;
  errors: string[];
  rollbackSnapshotId?: string;
}

export interface SourceBundleManifest {
  id: string;
  bundleId: string;
  createdAt: string;
  encrypted: boolean;
  algorithm?: 'AES-GCM';
  sha256: string;
  byteLength: number;
  documentCount: number;
  chunkCount: number;
  sourceIds: string[];
  staleAt?: string;
  privateUseOnly: boolean;
}

export interface PsychometricStats {
  id: string;
  itemId: string;
  level: string;
  topic: string;
  attempts: number;
  difficulty: number;
  discrimination: number;
  distractorQuality: Record<string, number>;
  reliability?: number;
  retakeDrift?: number;
  updatedAt: string;
}

export interface FormulaDependency {
  id: string;
  formulaName: string;
  level?: string;
  topic: string;
  dependsOn: string[];
  usedBy: string[];
  sourceIds?: string[];
  updatedAt: string;
}

export interface SourceCoverageStatus {
  targetId: string;
  targetKind: 'lesson' | 'question' | 'formula' | 'mock' | 'rubric';
  status: 'covered' | 'partial' | 'missing' | 'stale';
  sourceIds: string[];
  staleAt?: string;
  updatedAt: string;
}

export interface ConstructedResponseRubricHistory {
  id: string;
  attemptId?: number;
  itemId: string;
  criterion: string;
  earnedPoints: number;
  maxPoints: number;
  scorer: 'local-rubric' | 'self' | 'grounded-tutor';
  sourceIds: string[];
  createdAt: string;
}

export interface MockBlueprint {
  id: string;
  level: 'level1' | 'level2' | 'level3';
  title: string;
  pathway?: string;
  officialLength: boolean;
  totalMinutes: number;
  breakMinutes: number;
  sessions: Array<{
    id: string;
    label: string;
    minutes: number;
    itemTypes: Array<'single' | 'vignette' | 'constructed-response' | 'trial'>;
    scoredItemCount: number;
    trialItemCount: number;
  }>;
  scoringBands: Array<{ label: string; minPct: number; maxPct: number }>;
  topicWeights: Record<string, number>;
  reviewPacketTemplate: string[];
  variantSeed?: string;
  createdAt: string;
  updatedAt: string;
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
  secureVault?: VaultNoteSecurePayload;
}

export type VaultNoteSecureCipher = VaultSecureCipher;

export interface VaultNoteSecurePayload {
  v: 1;
  scheme: 'secure-vault-note.v1';
  title: VaultNoteSecureCipher;
  body: VaultNoteSecureCipher;
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

// LEARN-1 — unified cross-domain ability model. Pure shapes (no I/O) mirroring
// the LSAT backend's `adaptivity.ability_estimate` payload + `domain`, read from
// GET /api/adaptivity/ability?domain=<plane>. The `domain` plane can be a host
// domain OR the LSAT plane ('lsat'), so it widens DomainId.
export type AbilityDomain = DomainId | 'lsat';

export interface UnifiedAbilityEstimate {
  domain: AbilityDomain;
  q_type: string | null;
  section_type: string | null;
  ability: number;
  mastery: number;
  uncertainty: number;
  evidence_n: number;
  accuracy: number | null;
  avg_time_ms: number | null;
  model: string;
  learning_velocity: {
    slope_per_week: number;
    window: string;
    early_signal: number | null;
    recent_signal: number | null;
    days?: number;
  };
  plateau: boolean;
  mastery_eta_days: number | null;
  components: {
    blind_review_outcomes: Record<string, number>;
    days: number | null;
    model: string;
    uses_official_score_anchor_only: boolean;
  };
}

export interface PerDomainAbilitySnapshot {
  domain: AbilityDomain;
  theta: number;
  mastery: number;
  uncertainty: number;
  slope: number;
  evidence_n: number;
}
