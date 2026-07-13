import Dexie, { type Table } from 'dexie';
import type {
  CalculatorScenario,
  Confidence,
  ConfidenceCalibration,
  ConstructedResponseAttempt,
  ContentVersion,
  FlashcardAttempt,
  FormulaDrillAttempt,
  ImportJob,
  LearningEventEnvelope,
  LessonProgress,
  MasterySnapshot,
  MockAttempt,
  MockBlueprint,
  MockSectionState,
  PsychometricStats,
  QuestionResult,
  QuizAttempt,
  ReleaseRunHistory,
  ResultArtifact,
  ReviewEvent,
  ReviewItem,
  SkillLabAttempt,
  SourceBundleManifest,
  StudyPlanSettings,
  StudySession,
  VignetteAttempt,
  VaultBookmark,
  VaultHealthSnapshot,
  VaultNote,
  RollbackSnapshot,
} from './learningTypes';
import type {
  CfaSourceChunk,
  CfaSourceDocument,
  CfaSourceIndex,
  CfaSourceIngestionRun,
  CfaSourceLink,
  CfaSourceLinkOverride,
} from './cfaSourceTypes';

export const VAULT_SCHEMA_VERSION = 12;
export const VAULT_SCHEMA_HASH = 'qv-v12-ability-snapshots-study-trail';
export const VAULT_CONTENT_VERSION = 'cfa-2026-local-pack-v1';

export type SettingRow = { key: string; value: unknown; updatedAt: string };

export type QuestionResultRow = QuestionResult & {
  id?: number;
  selected?: number;
  correctIndex?: number;
  formula?: string;
  title?: string;
  objectiveTitle?: string;
  path?: string;
  level?: string;
  itemType?: string;
  createdAt: string;
  // ANL-3 — blind-review capture (append-only, optional; see `QuestionResult`).
  brAnswer?: number;
  brConfidence?: Confidence;
  brCorrect?: boolean;
};

export type QuizAttemptRow = Omit<QuizAttempt, 'answers'> & {
  answers: QuestionResultRow[];
};

type AbilitySnapshotRow = {
  id: string;
  domain: string;
  theta: number;
  uncertainty: number;
  difficultyMapping: {
    model: string;
    items: Array<{ id: string; b: number; empiricalDifficulty: number }>;
  };
  calibrationResiduals: Array<{ id: string; observed: number; expected: number; residual: number }>;
  modelVersion: string;
  at: string;
};

type StudyTrailEntryRow = {
  id: string;
  domain: string;
  route: string;
  label: string;
  queryState?: Record<string, string>;
  resumeHandle?: string;
  recordedAt: string;
};

export type VaultDatabase = Dexie & {
  lessonProgress: Table<LessonProgress, string>;
  quizAttempts: Table<QuizAttemptRow, number>;
  questionResults: Table<QuestionResultRow, number>;
  reviewItems: Table<ReviewItem, string>;
  masterySnapshots: Table<MasterySnapshot, string>;
  mockAttempts: Table<MockAttempt, number>;
  vignetteAttempts: Table<VignetteAttempt, number>;
  constructedResponseAttempts: Table<ConstructedResponseAttempt, number>;
  formulaDrillAttempts: Table<FormulaDrillAttempt, number>;
  skillLabAttempts: Table<SkillLabAttempt, number>;
  studySessions: Table<StudySession, number>;
  studyPlanSettings: Table<StudyPlanSettings, string>;
  contentVersions: Table<ContentVersion, string>;
  reviewEvents: Table<ReviewEvent, number>;
  confidenceCalibration: Table<ConfidenceCalibration, number>;
  flashcardAttempts: Table<FlashcardAttempt, number>;
  resultArtifacts: Table<ResultArtifact, string>;
  mockSectionState: Table<MockSectionState, string>;
  learningEvents: Table<LearningEventEnvelope, string>;
  vaultHealthSnapshots: Table<VaultHealthSnapshot, string>;
  rollbackSnapshots: Table<RollbackSnapshot, string>;
  calculatorScenarios: Table<CalculatorScenario, string>;
  releaseRunHistory: Table<ReleaseRunHistory, string>;
  importJobs: Table<ImportJob, string>;
  sourceBundleManifests: Table<SourceBundleManifest, string>;
  psychometricStats: Table<PsychometricStats, string>;
  mockBlueprints: Table<MockBlueprint, string>;
  notes: Table<VaultNote, string>;
  bookmarks: Table<VaultBookmark, string>;
  settings: Table<SettingRow, string>;
  // DATA-1 Phase 3 — PSY-11 ability snapshots (psychometrics/abilitySnapshots.ts)
  // + NAV-1 study trail (studyTrail.ts). Registered here so their
  // getStorage().table(name) writes persist on Dexie; intentionally NOT in
  // STORE_NAMES / VaultDataStores — they are derived telemetry (ability snapshots
  // are recomputable from attempts; the trail is ephemeral navigation history),
  // so they are excluded from the canonical vault export the way the unexported
  // source* stores are. resetVaultData('full') still clears them via SOURCE-style
  // handling below.
  abilitySnapshots: Table<AbilitySnapshotRow, string>;
  studyTrail: Table<StudyTrailEntryRow, string>;
  sourceDocuments: Table<CfaSourceDocument, string>;
  sourceChunks: Table<CfaSourceChunk, string>;
  sourceIndexes: Table<CfaSourceIndex, string>;
  sourceIngestionRuns: Table<CfaSourceIngestionRun, string>;
  sourceLinks: Table<CfaSourceLink, string>;
  sourceLinkOverrides: Table<CfaSourceLinkOverride, string>;
};

export const db = new Dexie('quantvault') as VaultDatabase;

db.version(1).stores({
  lessonProgress: 'id, domain, moduleId, completed, updatedAt, lastVisitedAt',
  quizAttempts: '++id, domain, topic, pct, createdAt',
  bookmarks: 'id, type, domain, moduleId, createdAt',
  settings: 'key',
});

/* D1: Intermediate migration v2 — adds question results and review system */
db.version(2).stores({
  lessonProgress: 'id, domain, moduleId, completed, updatedAt, lastVisitedAt',
  quizAttempts: '++id, domain, topic, pct, createdAt',
  questionResults: '++id, domain, topic, learningObjective, questionId, correct, createdAt',
  reviewItems: 'id, domain, topic, learningObjective, dueAt, ease, attempts',
  masterySnapshots: 'id, domain, topic, learningObjective, score, lastAttemptAt, nextReviewAt',
  bookmarks: 'id, type, domain, moduleId, createdAt',
  settings: 'key',
});

/* D1: Intermediate migration v3 — adds mock exams and assessment types */
db.version(3).stores({
  lessonProgress: 'id, domain, moduleId, completed, updatedAt, lastVisitedAt',
  quizAttempts: '++id, domain, topic, pct, createdAt, mode',
  questionResults: '++id, domain, topic, learningObjective, questionId, correct, createdAt',
  reviewItems: 'id, domain, topic, learningObjective, dueAt, ease, attempts',
  masterySnapshots: 'id, domain, topic, learningObjective, score, lastAttemptAt, nextReviewAt',
  mockAttempts: '++id, domain, level, pct, createdAt, mode',
  vignetteAttempts: '++id, domain, level, topic, vignetteId, pct, createdAt',
  constructedResponseAttempts: '++id, domain, level, topic, itemId, pct, createdAt',
  formulaDrillAttempts: '++id, domain, level, topic, formulaName, correct, createdAt',
  bookmarks: 'id, type, domain, moduleId, createdAt',
  settings: 'key',
});

/* D1: Intermediate migration v4 — adds study sessions, drills, and notes */
db.version(4).stores({
  lessonProgress: 'id, domain, moduleId, completed, updatedAt, lastVisitedAt',
  quizAttempts: '++id, domain, topic, pct, createdAt, mode',
  questionResults: '++id, domain, topic, learningObjective, questionId, correct, createdAt',
  reviewItems: 'id, domain, topic, learningObjective, dueAt, ease, attempts',
  masterySnapshots: 'id, domain, topic, learningObjective, score, lastAttemptAt, nextReviewAt',
  mockAttempts: '++id, domain, level, pct, createdAt, mode',
  vignetteAttempts: '++id, domain, level, topic, vignetteId, pct, createdAt',
  constructedResponseAttempts: '++id, domain, level, topic, itemId, pct, createdAt',
  formulaDrillAttempts: '++id, domain, level, topic, formulaName, correct, createdAt',
  skillLabAttempts: '++id, domain, level, topic, labId, labType, createdAt',
  studySessions: '++id, domain, topic, mode, startedAt',
  studyPlanSettings: 'id, updatedAt, examDate',
  contentVersions: 'id, version, updatedAt',
  reviewEvents: '++id, domain, topic, learningObjective, eventType, createdAt',
  confidenceCalibration: '++id, domain, topic, learningObjective, confidence, correct, createdAt',
  flashcardAttempts: '++id, domain, topic, cardId, outcome, createdAt',
  resultArtifacts: 'id, type, domain, topic, createdAt',
  mockSectionState: 'id, status, updatedAt, expiresAt',
  notes: 'id, type, domain, moduleId, questionId, formulaName, updatedAt',
  bookmarks: 'id, type, domain, moduleId, questionId, formulaName, createdAt',
  settings: 'key',
});

/* D1: Schema v5 — full 21-store architecture */
db.version(5).stores({
  lessonProgress: 'id, domain, moduleId, completed, updatedAt, lastVisitedAt',
  quizAttempts: '++id, domain, topic, pct, createdAt, mode',
  questionResults: '++id, domain, topic, learningObjective, questionId, correct, createdAt',
  reviewItems: 'id, domain, topic, learningObjective, dueAt, ease, attempts',
  masterySnapshots: 'id, domain, topic, learningObjective, score, lastAttemptAt, nextReviewAt',
  mockAttempts: '++id, domain, level, pct, createdAt, mode',
  vignetteAttempts: '++id, domain, level, topic, vignetteId, pct, createdAt',
  constructedResponseAttempts: '++id, domain, level, topic, itemId, pct, createdAt',
  formulaDrillAttempts: '++id, domain, level, topic, formulaName, correct, createdAt',
  skillLabAttempts: '++id, domain, level, topic, labId, labType, createdAt',
  studySessions: '++id, domain, topic, mode, startedAt',
  studyPlanSettings: 'id, updatedAt, examDate',
  contentVersions: 'id, version, updatedAt',
  reviewEvents: '++id, domain, topic, learningObjective, eventType, createdAt',
  confidenceCalibration: '++id, domain, topic, learningObjective, confidence, correct, createdAt',
  flashcardAttempts: '++id, domain, topic, cardId, outcome, createdAt',
  resultArtifacts: 'id, type, domain, topic, createdAt',
  mockSectionState: 'id, status, updatedAt, expiresAt',
  notes: 'id, type, domain, moduleId, questionId, formulaName, updatedAt',
  bookmarks: 'id, type, domain, moduleId, questionId, formulaName, createdAt',
  settings: 'key',
});

/* D1: Schema v11 — resilience control plane, rollback snapshots, and private source bundles */
db.version(11).stores({
  lessonProgress: 'id, domain, moduleId, completed, updatedAt, lastVisitedAt',
  quizAttempts: '++id, domain, topic, pct, createdAt, mode',
  questionResults: '++id, domain, topic, learningObjective, questionId, correct, createdAt',
  reviewItems: 'id, domain, topic, learningObjective, dueAt, ease, fsrsDifficulty, attempts',
  masterySnapshots: 'id, domain, topic, learningObjective, score, lastAttemptAt, nextReviewAt',
  mockAttempts: '++id, domain, level, pct, createdAt, mode',
  vignetteAttempts: '++id, domain, level, topic, vignetteId, pct, createdAt',
  constructedResponseAttempts: '++id, domain, level, topic, itemId, pct, createdAt',
  formulaDrillAttempts: '++id, domain, level, topic, formulaName, correct, createdAt',
  skillLabAttempts: '++id, domain, level, topic, labId, labType, createdAt',
  studySessions: '++id, domain, topic, mode, startedAt',
  studyPlanSettings: 'id, updatedAt, examDate',
  contentVersions: 'id, version, updatedAt',
  reviewEvents: '++id, domain, topic, learningObjective, eventType, createdAt',
  confidenceCalibration: '++id, domain, topic, learningObjective, confidence, correct, createdAt',
  flashcardAttempts: '++id, domain, topic, cardId, outcome, createdAt',
  resultArtifacts: 'id, type, domain, topic, createdAt',
  mockSectionState: 'id, status, updatedAt, expiresAt',
  learningEvents: 'id, recordedAt',
  vaultHealthSnapshots: 'id, generatedAt, status',
  rollbackSnapshots: 'id, createdAt, reason',
  calculatorScenarios: 'id, calculatorId, updatedAt',
  releaseRunHistory: 'id, runId, generatedAt, status',
  importJobs: 'id, startedAt, status',
  sourceBundleManifests: 'id, bundleId, createdAt, encrypted',
  psychometricStats: 'id, level, topic, itemId',
  mockBlueprints: 'id, level, updatedAt',
  notes: 'id, type, domain, moduleId, questionId, formulaName, updatedAt',
  bookmarks: 'id, type, domain, moduleId, questionId, formulaName, createdAt',
  settings: 'key',
  sourceDocuments: 'id, level, year, publisher, sourceKind, format, sha256, canonical, importedAt',
  sourceChunks: 'id, documentId, chunkIndex, sourceHash, importedAt',
  sourceIndexes: 'id, token, updatedAt',
  sourceIngestionRuns: 'id, rootPath, startedAt, status',
  sourceLinks: 'id, targetId, targetKind, documentId, chunkId, score, rank, sourcePriority, createdAt',
  sourceLinkOverrides: 'id, targetId, chunkId, action, updatedAt',
});

/* D1: Current schema v12 — DATA-1 Phase 3 registers the two previously-deferred
 * stores so PSY-11 ability snapshots + NAV-1 study trail persist on Dexie. Dexie
 * carries forward every store from v11, so this incremental version only declares
 * the two NEW stores. Index strings match the queries each slice issues:
 *   - abilitySnapshots (abilitySnapshots.ts): keyed by `id`; reads via toArray()
 *     then JS-filters on `domain` and sorts on `at`. `modelVersion` is indexed per
 *     the slice's wiring note. (`difficultyMapping`/`calibrationResiduals` are
 *     nested payload — stored verbatim, not indexed.)
 *   - studyTrail (studyTrail.ts): keyed by `id`; reads via toArray() then
 *     JS-filters on `domain`, sorts on `recordedAt`, and bulkDeletes by `id`. */
db.version(VAULT_SCHEMA_VERSION).stores({
  abilitySnapshots: 'id, domain, at, modelVersion',
  studyTrail: 'id, domain, recordedAt',
});
