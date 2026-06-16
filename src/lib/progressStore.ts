import Dexie, { liveQuery, type Table } from 'dexie';
import {
  isDue,
  masteryScoreForResults,
  nextRecommendation,
  predictRetention,
  rankReviewItems,
  scheduleReview,
} from './scheduler';
import type {
  AnalyticsSummary,
  ConfidenceCalibration,
  ConfidenceCalibrationSummary,
  ContentVersion,
  Confidence,
  Difficulty,
  DomainId,
  ErrorCategory,
  FlashcardAttempt,
  ImportJob,
  FormulaDrillAttempt,
  LessonProgress,
  LearningEventEnvelope,
  MasterySnapshot,
  MockSectionState,
  MockAttempt,
  ConstructedResponseAttempt,
  ObjectiveReadiness,
  ObjectiveReadinessV2,
  QuestionResult,
  QuizAttempt,
  RetentionForecast,
  ResultArtifact,
  ReviewEvent,
  ReviewQueueItem,
  ReviewItem,
  ReviewReason,
  CalculatorScenario,
  SkillLabAttempt,
  SourceBundleManifest,
  StudySessionPlan,
  StudyPlanSettings,
  StudySession,
  ReleaseRunHistory,
  RollbackSnapshot,
  PsychometricStats,
  TopicReadiness,
  VignetteAttempt,
  MockBlueprint,
  VaultRollbackReason,
  VaultBookmark,
  VaultHealthReport,
  VaultHealthSnapshot,
  VaultImportHistoryEntry,
  VaultNote,
} from './learningTypes';
import type {
  CfaSourceChunk,
  CfaSourceDocument,
  CfaSourceIndex,
  CfaSourceIngestionRun,
  CfaSourceLink,
  CfaSourceLinkOverride,
  CfaSourceVaultStores,
} from './cfaSourceTypes';
import { level3PathwayForTopic, level3TopicBelongsToPathway } from '../domains/cfa/cfaLevel3Pathways';
import {
  DEFAULT_SHARED_STUDY_PROFILE,
  type SharedStudyProfile,
  type StudyProfilePatch,
} from './types/StudyProfile';

export const PROGRESS_EVENT = 'quantvault:progress';
const PROGRESS_CHANNEL = 'quantvault:progress-channel';
export const VAULT_SCHEMA_VERSION = 11;
export const VAULT_SCHEMA_HASH = 'qv-v11-resilience-control-plane';
export const VAULT_CONTENT_VERSION = 'cfa-2026-local-pack-v1';

type SettingRow = { key: string; value: unknown; updatedAt: string };
type QuestionResultRow = QuestionResult & {
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
};

type QuizAttemptRow = Omit<QuizAttempt, 'answers'> & {
  answers: QuestionResultRow[];
};

type Level3PathwayQuery = {
  level3Pathway?: string;
};

export type VaultDataStores = {
  lessonProgress: LessonProgress[];
  quizAttempts: QuizAttemptRow[];
  questionResults: QuestionResultRow[];
  reviewItems: ReviewItem[];
  masterySnapshots: MasterySnapshot[];
  mockAttempts: MockAttempt[];
  vignetteAttempts: VignetteAttempt[];
  constructedResponseAttempts: ConstructedResponseAttempt[];
  formulaDrillAttempts: FormulaDrillAttempt[];
  skillLabAttempts: SkillLabAttempt[];
  studySessions: StudySession[];
  studyPlanSettings: StudyPlanSettings[];
  contentVersions: ContentVersion[];
  reviewEvents: ReviewEvent[];
  confidenceCalibration: ConfidenceCalibration[];
  flashcardAttempts: FlashcardAttempt[];
  resultArtifacts: ResultArtifact[];
  mockSectionState: MockSectionState[];
  learningEvents: LearningEventEnvelope[];
  vaultHealthSnapshots: VaultHealthSnapshot[];
  rollbackSnapshots: RollbackSnapshot[];
  calculatorScenarios: CalculatorScenario[];
  releaseRunHistory: ReleaseRunHistory[];
  importJobs: ImportJob[];
  sourceBundleManifests: SourceBundleManifest[];
  psychometricStats: PsychometricStats[];
  mockBlueprints: MockBlueprint[];
  notes: VaultNote[];
  bookmarks: VaultBookmark[];
  settings: SettingRow[];
};

export type VaultExport = {
  app: 'QuantVault';
  exportId: string;
  schemaVersion: number;
  schemaHash: string;
  contentVersion: string;
  exportedAt: string;
  checksum: string;
  encryption?: {
    encrypted: boolean;
    algorithm: 'none' | 'AES-GCM';
    keyDerivation?: 'PBKDF2';
  };
  stores: VaultDataStores;
  sourceVault?: CfaSourceVaultStores;
};

export type EncryptedVaultExport = Omit<VaultExport, 'stores' | 'encryption'> & {
  encryption: {
    encrypted: true;
    algorithm: 'AES-GCM';
    keyDerivation: 'PBKDF2';
    iterations: number;
    salt: string;
    iv: string;
    hash: 'SHA-256';
  };
  payload: string;
};

export type VaultExportOptions = {
  encryption?: {
    passphrase: string;
  };
  includeSourceVault?: boolean;
};

export type VaultImportOptions = {
  mode?: 'merge' | 'replace';
  passphrase?: string;
  conflictPolicy?: 'keep-existing' | 'prefer-import' | 'replace';
  includeSourceVault?: boolean;
};

type VaultDatabase = Dexie & {
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
  sourceDocuments: Table<CfaSourceDocument, string>;
  sourceChunks: Table<CfaSourceChunk, string>;
  sourceIndexes: Table<CfaSourceIndex, string>;
  sourceIngestionRuns: Table<CfaSourceIngestionRun, string>;
  sourceLinks: Table<CfaSourceLink, string>;
  sourceLinkOverrides: Table<CfaSourceLinkOverride, string>;
};

const STORE_NAMES = [
  'lessonProgress',
  'quizAttempts',
  'questionResults',
  'reviewItems',
  'masterySnapshots',
  'mockAttempts',
  'vignetteAttempts',
  'constructedResponseAttempts',
  'formulaDrillAttempts',
  'skillLabAttempts',
  'studySessions',
  'studyPlanSettings',
  'contentVersions',
  'reviewEvents',
  'confidenceCalibration',
  'flashcardAttempts',
  'resultArtifacts',
  'mockSectionState',
  'learningEvents',
  'vaultHealthSnapshots',
  'rollbackSnapshots',
  'calculatorScenarios',
  'releaseRunHistory',
  'importJobs',
  'sourceBundleManifests',
  'psychometricStats',
  'mockBlueprints',
  'notes',
  'bookmarks',
  'settings',
] as const;

const AUTO_ID_STORES = new Set<(typeof STORE_NAMES)[number]>([
  'quizAttempts',
  'questionResults',
  'mockAttempts',
  'vignetteAttempts',
  'constructedResponseAttempts',
  'formulaDrillAttempts',
  'skillLabAttempts',
  'studySessions',
  'reviewEvents',
  'confidenceCalibration',
  'flashcardAttempts',
]);

const SOURCE_STORE_NAMES = ['sourceDocuments', 'sourceChunks', 'sourceIndexes', 'sourceIngestionRuns', 'sourceLinks', 'sourceLinkOverrides'] as const;

export type VaultImportPreviewBase = {
  valid: boolean;
  errors: string[];
  schemaVersion: number | null;
  schemaHash: string | null;
  contentVersion: string | null;
  exportId: string | null;
  checksumValid: boolean;
  counts: Record<(typeof STORE_NAMES)[number], number>;
  sourceCounts: Record<(typeof SOURCE_STORE_NAMES)[number], number>;
};

export type VaultImportPreview = VaultImportPreviewBase & {
  encrypted: boolean;
  exportedAt: string | null;
  totalRows: number;
  sourceIncluded: boolean;
  sourceAvailable: boolean;
  conflictPolicy: 'keep-existing' | 'prefer-import' | 'replace';
  conflicts: {
    total: number;
    byStore: Partial<Record<(typeof STORE_NAMES)[number], number>>;
  };
};

const CONFIDENCE_SCORE: Record<Confidence, number> = {
  low: 34,
  medium: 67,
  high: 100,
};

const DIFFICULTIES: Difficulty[] = ['foundation', 'intermediate', 'advanced'];
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];
const ERROR_CATEGORIES: ErrorCategory[] = [
  'concept',
  'calculation',
  'formula',
  'ethics-judgment',
  'misread',
  'time-pressure',
  'none',
];

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

/* D1: Current schema v11 — resilience control plane, rollback snapshots, and private source bundles */
db.version(VAULT_SCHEMA_VERSION).stores({
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

function nowIso() {
  return new Date().toISOString();
}

let sharedProgressChannel: BroadcastChannel | null | undefined;

function getSharedProgressChannel() {
  if (sharedProgressChannel !== undefined) return sharedProgressChannel;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  sharedProgressChannel = new BroadcastChannel(PROGRESS_CHANNEL);
  return sharedProgressChannel;
}

function createProgressChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(PROGRESS_CHANNEL);
}

function emitProgressChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PROGRESS_EVENT));
  }
  getSharedProgressChannel()?.postMessage({ type: PROGRESS_EVENT, emittedAt: nowIso() });
}

export function subscribeProgressChanges(handler: () => void) {
  const channel = createProgressChannel();
  const handleWindowEvent = () => handler();
  const handleChannelMessage = (event: MessageEvent) => {
    if (event.data?.type === PROGRESS_EVENT) handler();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener(PROGRESS_EVENT, handleWindowEvent);
  }
  channel?.addEventListener('message', handleChannelMessage);

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener(PROGRESS_EVENT, handleWindowEvent);
    }
    channel?.removeEventListener('message', handleChannelMessage);
    channel?.close();
  };
}

function objectiveId(domain: DomainId, topic: string, learningObjective: string) {
  return `${domain}:${topic}:${learningObjective}`;
}

function defaultPathFor(domain: DomainId, topic: string, mode = 'review-due') {
  if (domain === 'cfa') {
    const [maybeLevel, maybeTopic] = topic.split(':');
    const level = maybeTopic ? maybeLevel : 'level1';
    const topicId = maybeTopic || topic;
    return `/cfa/${level}/${topicId}/quiz?mode=${mode}`;
  }
  return `/${domain}/${topic}`;
}

function isPathwayScopedLevel3Topic(topic?: string | null) {
  const pathway = level3PathwayForTopic(topic || '');
  return pathway !== null && pathway !== 'core';
}

function isLevel3TopicRow(row: { level?: string; topic?: string }) {
  return row.level === 'level3' || row.topic?.startsWith('level3:') || isPathwayScopedLevel3Topic(row.topic);
}

function level3TopicRowAllowed(row: { level?: string; topic?: string }, level3Pathway?: string) {
  if (!level3Pathway || !isLevel3TopicRow(row)) return true;
  return level3TopicBelongsToPathway(row.topic, level3Pathway);
}

function level3MockAttemptAllowed(attempt: MockAttempt, level3Pathway?: string) {
  if (!level3Pathway || attempt.level !== 'level3') return true;
  const pathwayTopics = attempt.topicBreakdown.map((row) => row.topic).filter(isPathwayScopedLevel3Topic);
  return !pathwayTopics.length || pathwayTopics.some((topic) => level3TopicBelongsToPathway(topic, level3Pathway));
}

function normalizeDifficulty(value: unknown): Difficulty {
  return DIFFICULTIES.includes(value as Difficulty) ? (value as Difficulty) : 'foundation';
}

function normalizeConfidence(value: unknown): Confidence {
  return CONFIDENCES.includes(value as Confidence) ? (value as Confidence) : 'medium';
}

function normalizeErrorCategory(value: unknown, correct: boolean): ErrorCategory {
  if (ERROR_CATEGORIES.includes(value as ErrorCategory)) return value as ErrorCategory;
  return correct ? 'none' : 'concept';
}

function isValidIsoDate(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function normalizeQuestionResult(
  result: Partial<QuestionResultRow> & {
    domain: DomainId;
    topic: string;
    questionId?: string;
    selected?: number;
    correctIndex?: number;
  },
  timestamp: string,
): QuestionResultRow {
  const correct = Boolean(result.correct);
  const questionId = result.questionId || `${result.topic}:question`;
  const learningObjective = result.learningObjective || `${result.topic}:general`;

  return {
    domain: result.domain,
    topic: result.topic,
    questionId,
    learningObjective,
    correct,
    confidence: normalizeConfidence(result.confidence),
    errorCategory: normalizeErrorCategory(result.errorCategory, correct),
    difficulty: normalizeDifficulty(result.difficulty),
    elapsedSeconds: result.elapsedSeconds,
    selected: result.selected,
    correctIndex: result.correctIndex,
    formula: result.formula,
    title: result.title,
    objectiveTitle: result.objectiveTitle,
    path: result.path,
    level: result.level,
    itemType: result.itemType,
    createdAt: result.createdAt || timestamp,
  };
}

async function updateMasterySnapshot(result: QuestionResultRow, review: ReviewItem) {
  const id = objectiveId(result.domain, result.topic, result.learningObjective);
  const existing = await db.masterySnapshots.get(id);
  const objectiveResults = await db.questionResults
    .where('learningObjective')
    .equals(result.learningObjective)
    .filter((row) => row.domain === result.domain && row.topic === result.topic)
    .toArray();
  const score = masteryScoreForResults(objectiveResults);
  const confidenceScore = Math.round(
    objectiveResults.reduce((sum, row) => sum + CONFIDENCE_SCORE[row.confidence], 0) /
      Math.max(1, objectiveResults.length),
  );
  const correct = objectiveResults.filter((row) => row.correct).length;
  const trend: MasterySnapshot['trend'] = existing
    ? score > existing.score + 3
      ? 'up'
      : score < existing.score - 3
        ? 'down'
        : 'flat'
    : 'new';

  await db.masterySnapshots.put({
    id,
    domain: result.domain,
    topic: result.topic,
    learningObjective: result.learningObjective,
    title: result.objectiveTitle || result.title || result.learningObjective,
    score,
    attempts: objectiveResults.length,
    correct,
    confidenceScore,
    lastAttemptAt: result.createdAt,
    nextReviewAt: review.dueAt,
    trend,
  });
}

async function persistQuestionResult(result: QuestionResultRow) {
  const id = objectiveId(result.domain, result.topic, result.learningObjective);
  const previous = await db.reviewItems.get(id);
  const review = buildReviewItem(result, previous);

  await db.questionResults.add(result);
  await db.reviewItems.put(review);
  await db.reviewEvents.add({
    domain: result.domain,
    topic: result.topic,
    learningObjective: result.learningObjective,
    eventType: previous ? 'rescheduled' : 'scheduled',
    reviewItemId: review.id,
    dueAt: review.dueAt,
    createdAt: result.createdAt,
  });
  await db.confidenceCalibration.add({
    domain: result.domain,
    topic: result.topic,
    learningObjective: result.learningObjective,
    questionId: result.questionId,
    confidence: result.confidence,
    correct: result.correct,
    createdAt: result.createdAt,
  });
  await updateMasterySnapshot(result, review);

  return review;
}

function buildReviewItem(result: QuestionResultRow, previous?: ReviewItem): ReviewItem {
  const id = objectiveId(result.domain, result.topic, result.learningObjective);
  const scheduled = scheduleReview(result, previous, new Date(result.createdAt));
  return {
    id,
    domain: result.domain,
    topic: result.topic,
    learningObjective: result.learningObjective,
    title: result.objectiveTitle || result.title || result.learningObjective,
    path: result.path || defaultPathFor(result.domain, result.topic),
    intervalDays: scheduled.intervalDays,
    ease: scheduled.ease,
    fsrsDifficulty: scheduled.fsrsDifficulty,
    dueAt: scheduled.dueAt,
    lastResultAt: result.createdAt,
    attempts: scheduled.attempts,
    correctStreak: scheduled.correctStreak,
    lastCorrect: result.correct,
    lastConfidence: result.confidence,
    lastErrorCategory: result.errorCategory,
  };
}

export function progressId(domain: DomainId, moduleId: string) {
  return `${domain}:${moduleId}`;
}

export async function getLessonProgress(domain: DomainId, moduleId: string) {
  return db.lessonProgress.get(progressId(domain, moduleId));
}

export async function recordModuleVisit({
  domain,
  moduleId,
  title,
  path,
}: {
  domain: DomainId;
  moduleId: string;
  title: string;
  path: string;
}) {
  const id = progressId(domain, moduleId);
  const existing = await db.lessonProgress.get(id);
  const timestamp = nowIso();

  await db.lessonProgress.put({
    id,
    domain,
    moduleId,
    title,
    path,
    completed: existing?.completed || false,
    visitCount: (existing?.visitCount || 0) + 1,
    createdAt: existing?.createdAt || timestamp,
    lastVisitedAt: timestamp,
    completedAt: existing?.completedAt || null,
    updatedAt: timestamp,
  });

  emitProgressChange();
  return db.lessonProgress.get(id);
}

export async function setModuleCompleted({
  domain,
  moduleId,
  title,
  path,
  completed,
}: {
  domain: DomainId;
  moduleId: string;
  title: string;
  path: string;
  completed: boolean;
}) {
  const id = progressId(domain, moduleId);
  const existing = await db.lessonProgress.get(id);
  const timestamp = nowIso();

  await db.lessonProgress.put({
    id,
    domain,
    moduleId,
    title,
    path,
    completed,
    visitCount: existing?.visitCount || 1,
    createdAt: existing?.createdAt || timestamp,
    lastVisitedAt: existing?.lastVisitedAt || timestamp,
    completedAt: completed ? timestamp : null,
    updatedAt: timestamp,
  });

  emitProgressChange();
  return db.lessonProgress.get(id);
}

export async function toggleModuleCompleted({
  domain,
  moduleId,
  title,
  path,
}: {
  domain: DomainId;
  moduleId: string;
  title: string;
  path: string;
}) {
  const existing = await db.lessonProgress.get(progressId(domain, moduleId));
  return setModuleCompleted({
    domain,
    moduleId,
    title,
    path,
    completed: !existing?.completed,
  });
}

export async function recordQuestionResult(
  result: Partial<QuestionResultRow> & {
    domain: DomainId;
    topic: string;
    questionId?: string;
    selected?: number;
    correctIndex?: number;
  },
) {
  const normalized = normalizeQuestionResult(result, nowIso());
  const review = await persistQuestionResult(normalized);
  emitProgressChange();
  return review;
}

export async function recordQuizAttempt({
  domain,
  topic,
  title,
  mode = 'topic-drill',
  score,
  total,
  elapsedSeconds,
  answers,
}: {
  domain: DomainId;
  topic: string;
  title: string;
  mode?: string;
  score: number;
  total: number;
  elapsedSeconds: number;
  answers: Array<Partial<QuestionResultRow> & { selected?: number; correctIndex?: number }>;
}) {
  const timestamp = nowIso();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const normalizedAnswers = answers.map((answer) =>
    normalizeQuestionResult(
      {
        ...answer,
        domain,
        topic,
        title,
        path: answer.path || defaultPathFor(domain, topic, mode),
      },
      timestamp,
    ),
  );

  await db.transaction(
    'rw',
    [
      db.quizAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.quizAttempts.add({
        domain,
        topic,
        title,
        mode,
        score,
        total,
        pct,
        elapsedSeconds,
        answers: normalizedAnswers,
        createdAt: timestamp,
      });

      for (const answer of normalizedAnswers) {
        await persistQuestionResult(answer);
      }

      await db.studySessions.add({
        domain,
        topic,
        mode,
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: total,
        score: pct,
      });
    },
  );

  emitProgressChange();
}

export async function getDueReviews(date = new Date(), options: Level3PathwayQuery = {}) {
  const reviewItems = await db.reviewItems.toArray();
  return rankReviewItems(reviewItems.filter((item) => level3TopicRowAllowed(item, options.level3Pathway)), date).filter((item) => isDue(item, date));
}

export async function getMasterySummary(options: Level3PathwayQuery = {}) {
  const snapshots = await db.masterySnapshots.toArray();
  const visibleSnapshots = snapshots.filter((snapshot) => level3TopicRowAllowed(snapshot, options.level3Pathway));
  const ranked = [...visibleSnapshots].sort((a, b) => a.score - b.score || b.lastAttemptAt.localeCompare(a.lastAttemptAt));
  return {
    snapshots: visibleSnapshots,
    weakObjectives: ranked.filter((snapshot) => snapshot.score < 72).slice(0, 6),
    averageScore: visibleSnapshots.length
      ? Math.round(visibleSnapshots.reduce((sum, snapshot) => sum + snapshot.score, 0) / visibleSnapshots.length)
      : null,
  };
}

export async function getNextRecommendation(options: Level3PathwayQuery = {}) {
  const [dueReviews, mastery, lessonProgress] = await Promise.all([
    getDueReviews(new Date(), options),
    getMasterySummary(options),
    db.lessonProgress.orderBy('lastVisitedAt').reverse().first(),
  ]);

  return nextRecommendation({
    dueReviews,
    weakObjectives: mastery.weakObjectives.map((objective) => ({
      title: objective.title,
      path: defaultPathFor(objective.domain, objective.topic, 'weak-areas'),
      score: objective.score,
    })),
    continuePath: lessonProgress && level3TopicRowAllowed({ topic: lessonProgress.moduleId }, options.level3Pathway) ? lessonProgress.path : null,
  });
}

function uniqueStudyDates(lessonProgress: LessonProgress[], attempts: QuizAttemptRow[], sessions: StudySession[] = []) {
  const dates = new Set<string>();
  lessonProgress.forEach((row) => {
    if (row.lastVisitedAt) dates.add(row.lastVisitedAt.slice(0, 10));
    if (row.completedAt) dates.add(row.completedAt.slice(0, 10));
  });
  attempts.forEach((row) => {
    if (row.createdAt) dates.add(row.createdAt.slice(0, 10));
  });
  sessions.forEach((row) => {
    if (row.startedAt) dates.add(row.startedAt.slice(0, 10));
    if (row.endedAt) dates.add(row.endedAt.slice(0, 10));
  });
  return [...dates].sort().reverse();
}

function computeStreak(dates: string[]) {
  if (!dates.length) return 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let expected = today.getTime();
  let streak = 0;
  const dateSet = new Set(dates);

  for (let i = 0; i < dates.length + 1; i += 1) {
    const key = new Date(expected).toISOString().slice(0, 10);
    if (!dateSet.has(key)) {
      if (streak === 0 && i === 0) {
        expected -= dayMs;
        continue;
      }
      break;
    }
    streak += 1;
    expected -= dayMs;
  }

  return streak;
}

export const emptyProgressSummary = {
  completedModules: 0,
  visitedModules: 0,
  questionsAnswered: 0,
  studyTimeSeconds: 0,
  masteryScore: null as number | null,
  streakDays: 0,
  lastActivity: null as string | null,
  latestAttempts: [] as QuizAttemptRow[],
  completedIds: new Set<string>(),
  upcomingReviews: [] as ReviewItem[],
  dueReviews: [] as ReviewItem[],
  weakObjectives: [] as MasterySnapshot[],
  todayRecommendation: {
    label: 'Start',
    title: 'Begin CFA Level I',
    path: '/cfa',
    reason: 'No local learning data has been recorded yet.',
  },
  notesCount: 0,
  bookmarksCount: 0,
  indexedDbAvailable: true,
};

export async function getProgressSummary() {
  try {
    const [
      lessonProgress,
      attempts,
      mockAttempts,
      vignetteAttempts,
      constructedResponseAttempts,
      formulaDrillAttempts,
      skillLabAttempts,
      flashcardAttempts,
      studySessions,
      reviewItems,
      masterySnapshots,
      notes,
      bookmarks,
    ] = await Promise.all([
      db.lessonProgress.toArray(),
      db.quizAttempts.orderBy('createdAt').reverse().toArray(),
      db.mockAttempts.orderBy('createdAt').reverse().toArray(),
      db.vignetteAttempts.orderBy('createdAt').reverse().toArray(),
      db.constructedResponseAttempts.orderBy('createdAt').reverse().toArray(),
      db.formulaDrillAttempts.orderBy('createdAt').reverse().toArray(),
      db.skillLabAttempts.orderBy('createdAt').reverse().toArray(),
      db.flashcardAttempts.orderBy('createdAt').reverse().toArray(),
      db.studySessions.toArray(),
      db.reviewItems.toArray(),
      db.masterySnapshots.toArray(),
      db.notes.toArray(),
      db.bookmarks.toArray(),
    ]);

    const completed = lessonProgress.filter((row) => row.completed);
    const questionsAnswered =
      attempts.reduce((sum, attempt) => sum + (attempt.total || 0), 0) +
      mockAttempts.reduce((sum, attempt) => sum + (attempt.total || 0), 0) +
      vignetteAttempts.reduce((sum, attempt) => sum + (attempt.total || 0), 0) +
      constructedResponseAttempts.length +
      formulaDrillAttempts.length +
      skillLabAttempts.length +
      flashcardAttempts.length;
    const studyTimeSeconds = studySessions.length
      ? studySessions.reduce((sum, session) => sum + (session.elapsedSeconds || 0), 0)
      : attempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0) +
        mockAttempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0) +
        vignetteAttempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0) +
        constructedResponseAttempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0) +
        formulaDrillAttempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0) +
        skillLabAttempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0) +
        flashcardAttempts.reduce((sum, attempt) => sum + (attempt.elapsedSeconds || 0), 0);
    const dates = uniqueStudyDates(lessonProgress, attempts, studySessions);
    const latestActivity = dates[0] || null;
    const dueReviews = rankReviewItems(reviewItems).filter((item) => isDue(item)).slice(0, 8);
    const weakObjectives = [...masterySnapshots]
      .filter((snapshot) => snapshot.score < 72)
      .sort((a, b) => a.score - b.score || b.lastAttemptAt.localeCompare(a.lastAttemptAt))
      .slice(0, 6);
    const masteryScore = masterySnapshots.length
      ? Math.round(masterySnapshots.reduce((sum, snapshot) => sum + snapshot.score, 0) / masterySnapshots.length)
      : attempts.length
        ? Math.round(attempts.reduce((sum, attempt) => sum + attempt.pct, 0) / attempts.length)
        : null;
    const latestModule = [...lessonProgress].sort((a, b) => b.lastVisitedAt.localeCompare(a.lastVisitedAt))[0];
    const todayRecommendation = nextRecommendation({
      dueReviews,
      weakObjectives: weakObjectives.map((objective) => ({
        title: objective.title,
        path: defaultPathFor(objective.domain, objective.topic, 'weak-areas'),
        score: objective.score,
      })),
      continuePath: latestModule?.path || null,
    });

    return {
      completedModules: completed.length,
      visitedModules: lessonProgress.length,
      questionsAnswered,
      studyTimeSeconds,
      masteryScore,
      streakDays: computeStreak(dates),
      lastActivity: latestActivity,
      latestAttempts: attempts.slice(0, 6),
      completedIds: new Set(completed.map((row) => row.id)),
      upcomingReviews: dueReviews,
      dueReviews,
      weakObjectives,
      todayRecommendation,
      notesCount: notes.length,
      bookmarksCount: bookmarks.length,
      indexedDbAvailable: true,
    };
  } catch {
    return {
      ...emptyProgressSummary,
      indexedDbAvailable: false,
    };
  }
}

export function progressSummaryQuery() {
  return liveQuery(getProgressSummary);
}

function noteIdFor({
  type,
  domain,
  moduleId,
  questionId,
  formulaName,
  artifactId,
}: Pick<VaultNote, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName' | 'artifactId'>) {
  return [type, domain || 'vault', artifactId || moduleId || questionId || formulaName || 'general'].join(':');
}

export async function getNote(target: Pick<VaultNote, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName' | 'artifactId'>) {
  return db.notes.get(noteIdFor(target));
}

export async function saveNote({
  type,
  domain,
  moduleId,
  questionId,
  formulaName,
  artifactId,
  title,
  body,
  path,
}: Omit<VaultNote, 'id' | 'createdAt' | 'updatedAt'>) {
  const id = noteIdFor({ type, domain, moduleId, questionId, formulaName, artifactId });
  const existing = await db.notes.get(id);
  const timestamp = nowIso();
  const note: VaultNote = {
    id,
    type,
    domain,
    moduleId,
    questionId,
    formulaName,
    artifactId,
    title,
    body,
    path,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };

  await db.notes.put(note);
  if (artifactId) await attachArtifactToNote(artifactId, id);
  emitProgressChange();
  return note;
}

export async function deleteNote(target: Pick<VaultNote, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName' | 'artifactId'>) {
  await db.notes.delete(noteIdFor(target));
  emitProgressChange();
}

function bookmarkIdFor({
  type,
  domain,
  moduleId,
  questionId,
  formulaName,
}: Pick<VaultBookmark, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName'>) {
  return [type, domain || 'vault', moduleId || questionId || formulaName].join(':');
}

export async function getBookmark(
  target: Pick<VaultBookmark, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName'>,
) {
  return db.bookmarks.get(bookmarkIdFor(target));
}

export async function toggleBookmark({
  type,
  domain,
  moduleId,
  questionId,
  formulaName,
  title,
  path,
}: Omit<VaultBookmark, 'id' | 'createdAt'>) {
  const id = bookmarkIdFor({ type, domain, moduleId, questionId, formulaName });
  const existing = await db.bookmarks.get(id);

  if (existing) {
    await db.bookmarks.delete(id);
    emitProgressChange();
    return null;
  }

  const bookmark: VaultBookmark = {
    id,
    type,
    domain,
    moduleId,
    questionId,
    formulaName,
    title,
    path,
    createdAt: nowIso(),
  };

  await db.bookmarks.put(bookmark);
  emitProgressChange();
  return bookmark;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const SHA256_INITIAL_HASH = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(source: string) {
  const bytes = Array.from(new TextEncoder().encode(source));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highBits >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowBits >>> shift) & 0xff);

  const hash = [...SHA256_INITIAL_HASH];
  const words = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] =
        ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const sigma0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const sigma1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + ch + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
}

function fnv1a32ForStablePayload(payload: unknown) {
  const source = stableStringify(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function checksumForStablePayload(payload: unknown) {
  return `sha256:${sha256Hex(stableStringify(payload))}`;
}

function checksumForExport(payload: Omit<VaultExport, 'checksum'>) {
  return checksumForStablePayload(payload);
}

function checksumMatchesPayload(payload: Record<string, unknown>, checksum: string) {
  const { checksum: _checksum, ...payloadForChecksum } = payload;
  if (checksum.startsWith('fnv1a32:')) return checksum === fnv1a32ForStablePayload(payloadForChecksum);
  return checksum === checksumForStablePayload(payloadForChecksum);
}

function exportIdFor(timestamp: string) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `qv-${timestamp.replace(/[^0-9]/g, '').slice(0, 14)}-${random}`;
}

function withChecksum(payload: Omit<VaultExport, 'checksum'>): VaultExport {
  return {
    ...payload,
    checksum: checksumForExport(payload),
  };
}

function buildVaultExport(stores: VaultDataStores, exportedAt = nowIso()): VaultExport {
  return withChecksum({
    app: 'QuantVault',
    exportId: exportIdFor(exportedAt),
    schemaVersion: VAULT_SCHEMA_VERSION,
    schemaHash: VAULT_SCHEMA_HASH,
    contentVersion: VAULT_CONTENT_VERSION,
    exportedAt,
    encryption: {
      encrypted: false,
      algorithm: 'none',
    },
    stores,
  });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function requireCryptoSubtle() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is required for encrypted vault exports.');
  return subtle;
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number) {
  if (!passphrase) throw new Error('Encrypted vault exports require a passphrase.');
  const subtle = requireCryptoSubtle();
  const material = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const saltBytes = new Uint8Array(salt);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptVaultExport(payload: VaultExport, passphrase: string): Promise<EncryptedVaultExport> {
  const subtle = requireCryptoSubtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const iterations = 210_000;
  const key = await deriveVaultKey(passphrase, salt, iterations);
  const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(stableStringify(payload))));
  const encryptedPayload: Omit<EncryptedVaultExport, 'checksum'> = {
    app: 'QuantVault',
    exportId: payload.exportId,
    schemaVersion: payload.schemaVersion,
    schemaHash: payload.schemaHash,
    contentVersion: payload.contentVersion,
    exportedAt: payload.exportedAt,
    encryption: {
      encrypted: true,
      algorithm: 'AES-GCM',
      keyDerivation: 'PBKDF2',
      iterations,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      hash: 'SHA-256',
    },
    payload: bytesToBase64(encrypted),
  };
  return {
    ...encryptedPayload,
    checksum: checksumForStablePayload(encryptedPayload),
  };
}

async function decryptVaultExport(payload: EncryptedVaultExport, passphrase?: string): Promise<VaultExport> {
  if (!passphrase) throw new Error('Encrypted QuantVault exports require a passphrase.');
  if (!checksumMatchesPayload(payload, payload.checksum)) {
    throw new Error('Encrypted vault export checksum does not match its payload.');
  }
  const key = await deriveVaultKey(passphrase, base64ToBytes(payload.encryption.salt), payload.encryption.iterations);
  try {
    const decrypted = await requireCryptoSubtle().decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(payload.encryption.iv) },
      key,
      base64ToBytes(payload.payload),
    );
    return migrateVaultData(JSON.parse(new TextDecoder().decode(decrypted)));
  } catch {
    throw new Error('Unable to decrypt vault export. Check the passphrase and payload integrity.');
  }
}

function isEncryptedVaultExport(payload: unknown): payload is EncryptedVaultExport {
  return isObject(payload) && isObject(payload.encryption) && payload.encryption.encrypted === true && payload.encryption.algorithm === 'AES-GCM' && typeof payload.payload === 'string';
}

export async function exportVaultData(): Promise<VaultExport>;
export async function exportVaultData(options: { encryption: { passphrase: string } }): Promise<EncryptedVaultExport>;
export async function exportVaultData(options: { includeSourceVault: true }): Promise<VaultExport>;
export async function exportVaultData(options: VaultExportOptions): Promise<VaultExport | EncryptedVaultExport>;
export async function exportVaultData(options: VaultExportOptions = {}): Promise<VaultExport | EncryptedVaultExport> {
  const [
    lessonProgress,
    quizAttempts,
    questionResults,
    reviewItems,
    masterySnapshots,
    mockAttempts,
    vignetteAttempts,
    constructedResponseAttempts,
    formulaDrillAttempts,
    skillLabAttempts,
    studySessions,
    studyPlanSettings,
    contentVersions,
    reviewEvents,
    confidenceCalibration,
    flashcardAttempts,
    resultArtifacts,
    mockSectionState,
    learningEvents,
    vaultHealthSnapshots,
    rollbackSnapshots,
    calculatorScenarios,
    releaseRunHistory,
    importJobs,
    sourceBundleManifests,
    psychometricStats,
    mockBlueprints,
    notes,
    bookmarks,
    settings,
  ] = await Promise.all([
    db.lessonProgress.toArray(),
    db.quizAttempts.toArray(),
    db.questionResults.toArray(),
    db.reviewItems.toArray(),
    db.masterySnapshots.toArray(),
    db.mockAttempts.toArray(),
    db.vignetteAttempts.toArray(),
    db.constructedResponseAttempts.toArray(),
    db.formulaDrillAttempts.toArray(),
    db.skillLabAttempts.toArray(),
    db.studySessions.toArray(),
    db.studyPlanSettings.toArray(),
    db.contentVersions.toArray(),
    db.reviewEvents.toArray(),
    db.confidenceCalibration.toArray(),
    db.flashcardAttempts.toArray(),
    db.resultArtifacts.toArray(),
    db.mockSectionState.toArray(),
    db.learningEvents.toArray(),
    db.vaultHealthSnapshots.toArray(),
    db.rollbackSnapshots.toArray(),
    db.calculatorScenarios.toArray(),
    db.releaseRunHistory.toArray(),
    db.importJobs.toArray(),
    db.sourceBundleManifests.toArray(),
    db.psychometricStats.toArray(),
    db.mockBlueprints.toArray(),
    db.notes.toArray(),
    db.bookmarks.toArray(),
    db.settings.toArray(),
  ]);

  const sourceVault: CfaSourceVaultStores | undefined = options.includeSourceVault
    ? {
        sourceDocuments: await db.sourceDocuments.toArray(),
        sourceChunks: await db.sourceChunks.toArray(),
        sourceIndexes: await db.sourceIndexes.toArray(),
        sourceIngestionRuns: await db.sourceIngestionRuns.toArray(),
        sourceLinks: await db.sourceLinks.toArray(),
        sourceLinkOverrides: await db.sourceLinkOverrides.toArray(),
      }
    : undefined;

  const vaultExport = buildVaultExport({
    lessonProgress,
    quizAttempts,
    questionResults,
    reviewItems,
    masterySnapshots,
    mockAttempts,
    vignetteAttempts,
    constructedResponseAttempts,
    formulaDrillAttempts,
    skillLabAttempts,
    studySessions,
    studyPlanSettings,
    contentVersions,
    reviewEvents,
    confidenceCalibration,
    flashcardAttempts,
    resultArtifacts,
    mockSectionState,
    learningEvents,
    vaultHealthSnapshots,
    rollbackSnapshots,
    calculatorScenarios,
    releaseRunHistory,
    importJobs,
    sourceBundleManifests,
    psychometricStats,
    mockBlueprints,
    notes,
    bookmarks,
    settings,
  });
  const { checksum: _checksum, ...vaultExportPayload } = vaultExport;
  const exportWithSource = sourceVault ? withChecksum({ ...vaultExportPayload, sourceVault }) : vaultExport;
  if (options.encryption) return encryptVaultExport(exportWithSource, options.encryption.passphrase);
  return exportWithSource;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyVaultStores(): VaultDataStores {
  return {
    lessonProgress: [],
    quizAttempts: [],
    questionResults: [],
    reviewItems: [],
    masterySnapshots: [],
    mockAttempts: [],
    vignetteAttempts: [],
    constructedResponseAttempts: [],
    formulaDrillAttempts: [],
    skillLabAttempts: [],
    studySessions: [],
    studyPlanSettings: [],
    contentVersions: [],
    reviewEvents: [],
    confidenceCalibration: [],
    flashcardAttempts: [],
    resultArtifacts: [],
    mockSectionState: [],
    learningEvents: [],
    vaultHealthSnapshots: [],
    rollbackSnapshots: [],
    calculatorScenarios: [],
    releaseRunHistory: [],
    importJobs: [],
    sourceBundleManifests: [],
    psychometricStats: [],
    mockBlueprints: [],
    notes: [],
    bookmarks: [],
    settings: [],
  };
}

function emptyVaultCounts(): Record<(typeof STORE_NAMES)[number], number> {
  return STORE_NAMES.reduce(
    (counts, storeName) => ({
      ...counts,
      [storeName]: 0,
    }),
    {} as Record<(typeof STORE_NAMES)[number], number>,
  );
}

function emptySourceVaultStores(): CfaSourceVaultStores {
  return {
    sourceDocuments: [],
    sourceChunks: [],
    sourceIndexes: [],
    sourceIngestionRuns: [],
    sourceLinks: [],
    sourceLinkOverrides: [],
  };
}

function emptySourceVaultCounts(): Record<(typeof SOURCE_STORE_NAMES)[number], number> {
  return SOURCE_STORE_NAMES.reduce(
    (counts, storeName) => ({
      ...counts,
      [storeName]: 0,
    }),
    {} as Record<(typeof SOURCE_STORE_NAMES)[number], number>,
  );
}

export function migrateVaultData(payload: unknown): VaultExport {
  if (!isObject(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const stores = isObject(payload.stores) ? payload.stores : {};
  const emptyStores = emptyVaultStores();
  const migratedStores = STORE_NAMES.reduce((result, storeName) => {
    return {
      ...result,
      [storeName]: Array.isArray(stores[storeName]) ? stores[storeName] : emptyStores[storeName],
    };
  }, emptyStores);
  const storesWithV6Defaults: VaultDataStores = {
    ...migratedStores,
    reviewItems: migratedStores.reviewItems.map((row) => ({
      ...row,
      fsrsDifficulty: Number.isFinite(row.fsrsDifficulty) ? row.fsrsDifficulty : 5,
    })),
  };
  const exportedAt = typeof payload.exportedAt === 'string' ? payload.exportedAt : nowIso();
  const sourceVaultPayload = isObject(payload.sourceVault) ? payload.sourceVault : undefined;
  const sourceVault = sourceVaultPayload
    ? {
        sourceDocuments: Array.isArray(sourceVaultPayload.sourceDocuments) ? (sourceVaultPayload.sourceDocuments as CfaSourceVaultStores['sourceDocuments']) : [],
        sourceChunks: Array.isArray(sourceVaultPayload.sourceChunks) ? (sourceVaultPayload.sourceChunks as CfaSourceVaultStores['sourceChunks']) : [],
        sourceIndexes: Array.isArray(sourceVaultPayload.sourceIndexes) ? (sourceVaultPayload.sourceIndexes as CfaSourceVaultStores['sourceIndexes']) : [],
        sourceIngestionRuns: Array.isArray(sourceVaultPayload.sourceIngestionRuns)
          ? (sourceVaultPayload.sourceIngestionRuns as CfaSourceVaultStores['sourceIngestionRuns'])
          : [],
        sourceLinks: Array.isArray(sourceVaultPayload.sourceLinks) ? (sourceVaultPayload.sourceLinks as CfaSourceVaultStores['sourceLinks']) : [],
        sourceLinkOverrides: Array.isArray(sourceVaultPayload.sourceLinkOverrides)
          ? (sourceVaultPayload.sourceLinkOverrides as CfaSourceVaultStores['sourceLinkOverrides'])
          : [],
      }
    : undefined;
  const baseExport: Omit<VaultExport, 'checksum'> = {
    app: payload.app === 'QuantVault' ? 'QuantVault' : 'QuantVault',
    exportId: typeof payload.exportId === 'string' ? payload.exportId : exportIdFor(exportedAt),
    schemaVersion: VAULT_SCHEMA_VERSION,
    schemaHash: typeof payload.schemaHash === 'string' ? payload.schemaHash : VAULT_SCHEMA_HASH,
    contentVersion: typeof payload.contentVersion === 'string' ? payload.contentVersion : VAULT_CONTENT_VERSION,
    exportedAt,
    encryption: isObject(payload.encryption)
      ? {
          encrypted: Boolean(payload.encryption.encrypted),
          algorithm: payload.encryption.algorithm === 'AES-GCM' ? 'AES-GCM' : 'none',
          keyDerivation: payload.encryption.keyDerivation === 'PBKDF2' ? 'PBKDF2' : undefined,
        }
      : {
          encrypted: false,
          algorithm: 'none',
    },
    stores: storesWithV6Defaults,
    ...(sourceVault ? { sourceVault } : {}),
  };

  const hasCurrentShaChecksum =
    payload.schemaVersion === VAULT_SCHEMA_VERSION &&
    payload.schemaHash === VAULT_SCHEMA_HASH &&
    typeof payload.checksum === 'string' &&
    payload.checksum.startsWith('sha256:');

  return {
    ...baseExport,
    checksum: hasCurrentShaChecksum ? (payload.checksum as string) : checksumForExport(baseExport),
  };
}

export function validateVaultData(payload: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  let migrated: VaultExport;

  try {
    migrated = migrateVaultData(payload);
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid payload.'] };
  }

  if (isObject(payload) && payload.app !== 'QuantVault') errors.push('Payload is not a QuantVault export.');
  if (isObject(payload) && typeof payload.checksum === 'string') {
    if (!checksumMatchesPayload(payload, payload.checksum)) {
      errors.push('Vault export checksum does not match its payload.');
    }
  }
  if (migrated.encryption?.encrypted) {
    errors.push('Encrypted QuantVault exports require decryption before import.');
  }
  STORE_NAMES.forEach((storeName) => {
    if (!Array.isArray(migrated.stores[storeName])) errors.push(`${storeName} must be an array.`);
  });
  if (migrated.sourceVault) {
    SOURCE_STORE_NAMES.forEach((storeName) => {
      if (!Array.isArray(migrated.sourceVault?.[storeName])) errors.push(`${storeName} must be an array.`);
    });
    const publicSourceDocuments = migrated.sourceVault.sourceDocuments.filter((document) => document.privateUseOnly !== true);
    if (publicSourceDocuments.length) {
      errors.push(`${publicSourceDocuments.length} source document rows are not marked privateUseOnly.`);
    }
    const orphanedSourceChunks = migrated.sourceVault.sourceChunks.filter(
      (chunk) => !migrated.sourceVault?.sourceDocuments.some((document) => document.id === chunk.documentId),
    );
    if (orphanedSourceChunks.length) {
      errors.push(`${orphanedSourceChunks.length} source chunk rows reference unknown source documents.`);
    }
    const sourceChunkIds = new Set(migrated.sourceVault.sourceChunks.map((chunk) => chunk.id));
    const sourceDocumentIds = new Set(migrated.sourceVault.sourceDocuments.map((document) => document.id));
    const sourceChunkById = new Map(migrated.sourceVault.sourceChunks.map((chunk) => [chunk.id, chunk]));
    const orphanedSourceLinks = (migrated.sourceVault.sourceLinks || []).filter((link) => !sourceChunkIds.has(link.chunkId));
    if (orphanedSourceLinks.length) {
      errors.push(`${orphanedSourceLinks.length} source link rows reference unknown source chunks.`);
    }
    const mismatchedSourceLinks = (migrated.sourceVault.sourceLinks || []).filter((link) => {
      const chunk = sourceChunkById.get(link.chunkId);
      return !sourceDocumentIds.has(link.documentId) || (chunk && chunk.documentId !== link.documentId);
    });
    if (mismatchedSourceLinks.length) {
      errors.push(`${mismatchedSourceLinks.length} source link rows have mismatched source document citations.`);
    }
    const orphanedSourceOverrides = (migrated.sourceVault.sourceLinkOverrides || []).filter((override) => !sourceChunkIds.has(override.chunkId));
    if (orphanedSourceOverrides.length) {
      errors.push(`${orphanedSourceOverrides.length} source override rows reference unknown source chunks.`);
    }
  }

  const invalidQuestionResults = migrated.stores.questionResults.filter(
    (row) => !row.domain || !row.topic || !row.questionId || !row.learningObjective,
  );
  if (invalidQuestionResults.length) {
    errors.push(`${invalidQuestionResults.length} question result rows are missing required identifiers.`);
  }
  const invalidQuestionEnums = migrated.stores.questionResults.filter(
    (row) =>
      (row.domain && row.domain !== 'cfa' && row.domain !== 'quant' && row.domain !== 'excel') ||
      (row.confidence && !CONFIDENCES.includes(row.confidence as Confidence)) ||
      (row.difficulty && !DIFFICULTIES.includes(row.difficulty as Difficulty)) ||
      (row.errorCategory && !ERROR_CATEGORIES.includes(row.errorCategory as ErrorCategory)),
  );
  if (invalidQuestionEnums.length) {
    errors.push(`${invalidQuestionEnums.length} question result rows contain invalid enum values.`);
  }
  const invalidDates = STORE_NAMES.flatMap((storeName) =>
    migrated.stores[storeName]
      .filter((row) => isObject(row) && 'createdAt' in row && !isValidIsoDate(row.createdAt))
      .map(() => storeName),
  );
  if (invalidDates.length) {
    errors.push(`${invalidDates.length} rows contain invalid createdAt timestamps.`);
  }
  const invalidScores = [
    ...migrated.stores.quizAttempts,
    ...migrated.stores.mockAttempts,
    ...migrated.stores.vignetteAttempts,
  ].filter((row) => row.total < 0 || row.score < 0 || row.score > row.total);
  if (invalidScores.length) {
    errors.push(`${invalidScores.length} attempt rows contain impossible score totals.`);
  }

  return { valid: errors.length === 0, errors };
}

export function previewVaultImport(payload: unknown): VaultImportPreviewBase {
  const validation = validateVaultData(payload);
  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors,
      schemaVersion: null,
      schemaHash: null,
      contentVersion: null,
      exportId: null,
      checksumValid: false,
      counts: emptyVaultCounts(),
      sourceCounts: emptySourceVaultCounts(),
    };
  }

  const migrated = migrateVaultData(payload);
  return {
    valid: true,
    errors: [],
    schemaVersion: migrated.schemaVersion,
    schemaHash: migrated.schemaHash,
    contentVersion: migrated.contentVersion,
    exportId: migrated.exportId,
    checksumValid: checksumMatchesPayload(migrated, migrated.checksum),
    counts: STORE_NAMES.reduce(
      (counts, storeName) => ({
        ...counts,
        [storeName]: migrated.stores[storeName].length,
      }),
      {} as Record<(typeof STORE_NAMES)[number], number>,
    ),
    sourceCounts: SOURCE_STORE_NAMES.reduce(
      (counts, storeName) => ({
        ...counts,
        [storeName]: migrated.sourceVault?.[storeName]?.length || 0,
      }),
      {} as Record<(typeof SOURCE_STORE_NAMES)[number], number>,
    ),
  };
}

function remapMergeIds(stores: VaultDataStores): VaultDataStores {
  return STORE_NAMES.reduce(
    (nextStores, storeName) => ({
      ...nextStores,
      [storeName]: AUTO_ID_STORES.has(storeName)
        ? stores[storeName].map((row) => {
            if (!isObject(row) || !('id' in row)) return row;
            const { id: _id, ...rest } = row;
            return rest;
          })
        : stores[storeName],
    }),
    emptyVaultStores(),
  );
}

function normalizeVaultImportOptions(options: 'merge' | 'replace' | VaultImportOptions = 'merge'): Required<Pick<VaultImportOptions, 'mode' | 'conflictPolicy' | 'includeSourceVault'>> &
  Pick<VaultImportOptions, 'passphrase'> {
  if (typeof options === 'string') {
    return { mode: options, conflictPolicy: options === 'replace' ? 'replace' : 'prefer-import', includeSourceVault: false };
  }
  const conflictPolicy = options.conflictPolicy || (options.mode === 'replace' ? 'replace' : 'prefer-import');
  return {
    mode: conflictPolicy === 'replace' ? 'replace' : options.mode || 'merge',
    conflictPolicy,
    passphrase: options.passphrase,
    includeSourceVault: options.includeSourceVault === true,
  };
}

function primaryKeyPathForStore(storeName: (typeof STORE_NAMES)[number]) {
  const keyPath = db[storeName].schema.primKey.keyPath;
  return typeof keyPath === 'string' ? keyPath : null;
}

function rowKey(row: unknown, keyPath: string | null) {
  return keyPath && isObject(row) ? row[keyPath] : undefined;
}

async function filterKeepExisting(stores: VaultDataStores): Promise<VaultDataStores> {
  const entries = await Promise.all(
    STORE_NAMES.map(async (storeName) => {
      if (AUTO_ID_STORES.has(storeName)) return [storeName, stores[storeName]] as const;
      const keyPath = primaryKeyPathForStore(storeName);
      const rows = stores[storeName];
      const keys = rows.map((row) => rowKey(row, keyPath));
      const existing = await db[storeName].bulkGet(keys.filter((key) => key !== undefined) as any[]);
      const existingKeys = new Set<unknown>(
        existing
          .filter(Boolean)
          .map((row) => rowKey(row, keyPath))
          .filter((key) => key !== undefined),
      );
      return [storeName, rows.filter((row) => !existingKeys.has(rowKey(row, keyPath)))] as const;
    }),
  );
  return entries.reduce(
    (nextStores, [storeName, rows]) => ({
      ...nextStores,
      [storeName]: rows,
    }),
    emptyVaultStores(),
  );
}

async function detectImportConflicts(stores: VaultDataStores) {
  const entries = await Promise.all(
    STORE_NAMES.map(async (storeName) => {
      if (AUTO_ID_STORES.has(storeName)) return [storeName, 0] as const;
      const keyPath = primaryKeyPathForStore(storeName);
      if (!keyPath) return [storeName, 0] as const;
      const keys = stores[storeName].map((row) => rowKey(row, keyPath)).filter((key) => key !== undefined) as any[];
      if (!keys.length) return [storeName, 0] as const;
      const existing = await db[storeName].bulkGet(keys);
      return [storeName, existing.filter(Boolean).length] as const;
    }),
  );
  const byStore = entries.reduce<Partial<Record<(typeof STORE_NAMES)[number], number>>>((result, [storeName, count]) => {
    if (count > 0) result[storeName] = count;
    return result;
  }, {});
  return {
    total: Object.values(byStore).reduce((sum, count) => sum + (count || 0), 0),
    byStore,
  };
}

async function resolveVaultImportPayload(payload: unknown, passphrase?: string): Promise<VaultExport> {
  if (isEncryptedVaultExport(payload)) return decryptVaultExport(payload, passphrase);
  return migrateVaultData(payload);
}

export async function previewVaultImportPayload(payload: unknown, options: VaultImportOptions = {}): Promise<VaultImportPreview> {
  const importOptions = normalizeVaultImportOptions(options);
  const encrypted = isEncryptedVaultExport(payload);

  try {
    const exportPayload = await resolveVaultImportPayload(payload, importOptions.passphrase);
    const preview = previewVaultImport(exportPayload);
    const totalRows = Object.values(preview.counts).reduce((sum, count) => sum + count, 0);
    const sourceAvailable = Object.values(preview.sourceCounts).some((count) => count > 0);
    return {
      ...preview,
      encrypted,
      exportedAt: exportPayload.exportedAt,
      totalRows,
      sourceIncluded: importOptions.includeSourceVault && sourceAvailable,
      sourceAvailable,
      conflictPolicy: importOptions.conflictPolicy,
      conflicts: importOptions.mode === 'merge' ? await detectImportConflicts(exportPayload.stores) : { total: 0, byStore: {} },
    };
  } catch (error) {
    return {
      ...previewVaultImport({}),
      valid: false,
      errors: [error instanceof Error ? error.message : 'Import preview failed.'],
      encrypted,
      exportedAt: null,
      totalRows: 0,
      sourceIncluded: false,
      sourceAvailable: false,
      conflictPolicy: importOptions.conflictPolicy,
      conflicts: { total: 0, byStore: {} },
    };
  }
}

async function appendVaultImportHistory({
  exportPayload,
  mode,
  conflictPolicy,
  encrypted,
}: {
  exportPayload: VaultExport;
  mode: 'merge' | 'replace';
  conflictPolicy: 'keep-existing' | 'prefer-import' | 'replace';
  encrypted: boolean;
}) {
  const key = 'vault:import-history';
  const existing = await db.settings.get(key);
  const current = Array.isArray(existing?.value) ? (existing.value as VaultImportHistoryEntry[]) : [];
  const entry: VaultImportHistoryEntry = {
    exportId: exportPayload.exportId,
    importedAt: nowIso(),
    exportedAt: exportPayload.exportedAt,
    schemaVersion: exportPayload.schemaVersion,
    schemaHash: exportPayload.schemaHash,
    contentVersion: exportPayload.contentVersion,
    mode,
    conflictPolicy,
    encrypted,
  };
  await db.settings.put({
    key,
    updatedAt: nowIso(),
    value: [entry, ...current].slice(0, 20),
  });
}

export async function getVaultImportHistory(): Promise<VaultImportHistoryEntry[]> {
  const existing = await db.settings.get('vault:import-history');
  return Array.isArray(existing?.value) ? (existing.value as VaultImportHistoryEntry[]) : [];
}

function vaultRowCounts(stores: VaultDataStores): Record<string, number> {
  return STORE_NAMES.reduce(
    (counts, storeName) => ({
      ...counts,
      [storeName]: stores[storeName].length,
    }),
    {} as Record<string, number>,
  );
}

function sourceVaultRowCounts(sourceVault?: CfaSourceVaultStores): Record<string, number> | undefined {
  if (!sourceVault) return undefined;
  return SOURCE_STORE_NAMES.reduce(
    (counts, storeName) => ({
      ...counts,
      [storeName]: sourceVault[storeName]?.length || 0,
    }),
    {} as Record<string, number>,
  );
}

export async function getRollbackSnapshots(limit = 10): Promise<RollbackSnapshot[]> {
  return db.rollbackSnapshots.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function createRollbackSnapshot(reason: VaultRollbackReason = 'manual'): Promise<RollbackSnapshot> {
  const exported = await exportVaultData();
  const { checksum: _checksum, ...rollbackPayloadWithoutChecksum } = {
    ...exported,
    stores: {
      ...exported.stores,
      rollbackSnapshots: [],
    },
  };
  const rollbackPayload = withChecksum(rollbackPayloadWithoutChecksum);
  const snapshot: RollbackSnapshot = {
    id: `rollback:${reason}:${exported.exportId}`,
    reason,
    createdAt: nowIso(),
    schemaVersion: exported.schemaVersion,
    schemaHash: exported.schemaHash,
    contentVersion: exported.contentVersion,
    checksum: rollbackPayload.checksum,
    encrypted: false,
    rowCounts: vaultRowCounts(exported.stores),
    sourceRowCounts: sourceVaultRowCounts(exported.sourceVault),
    payload: rollbackPayload,
  };
  await db.rollbackSnapshots.put(snapshot);
  const staleSnapshots = await db.rollbackSnapshots.orderBy('createdAt').reverse().offset(10).toArray();
  await Promise.all(staleSnapshots.map((stale) => db.rollbackSnapshots.delete(stale.id)));
  return snapshot;
}

export async function importVaultData(payload: unknown, mode?: 'merge' | 'replace'): Promise<void>;
export async function importVaultData(payload: unknown, options?: VaultImportOptions): Promise<void>;
export async function importVaultData(payload: unknown, options: 'merge' | 'replace' | VaultImportOptions = 'merge') {
  const importOptions = normalizeVaultImportOptions(options);
  const exportPayload = await resolveVaultImportPayload(payload, importOptions.passphrase);
  const importStartedAt = nowIso();
  const importJobId = `import-job:${exportPayload.exportId}:${importStartedAt.replace(/[^0-9]/g, '')}`;
  const encrypted = isEncryptedVaultExport(payload);
  const validation = validateVaultData(exportPayload);
  if (!validation.valid) {
    await db.importJobs.put({
      id: importJobId,
      startedAt: importStartedAt,
      completedAt: nowIso(),
      status: 'blocked',
      mode: importOptions.mode,
      conflictPolicy: importOptions.conflictPolicy,
      encrypted,
      includeSourceVault: importOptions.includeSourceVault,
      exportId: exportPayload.exportId,
      rowCounts: vaultRowCounts(exportPayload.stores),
      sourceRowCounts: sourceVaultRowCounts(exportPayload.sourceVault),
      errors: validation.errors,
    });
    throw new Error(validation.errors.join(' '));
  }
  const rollbackSnapshot = importOptions.mode === 'replace' ? await createRollbackSnapshot('import-replace') : undefined;
  const mergeStores = importOptions.mode === 'merge' ? remapMergeIds(exportPayload.stores) : exportPayload.stores;
  const storesToWrite =
    importOptions.mode === 'merge' && importOptions.conflictPolicy === 'keep-existing'
      ? await filterKeepExisting(mergeStores)
      : mergeStores;

  await db.transaction(
    'rw',
    [
      db.lessonProgress,
      db.quizAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.mockAttempts,
      db.vignetteAttempts,
      db.constructedResponseAttempts,
      db.formulaDrillAttempts,
      db.skillLabAttempts,
      db.studySessions,
      db.studyPlanSettings,
      db.contentVersions,
      db.reviewEvents,
      db.confidenceCalibration,
      db.flashcardAttempts,
      db.resultArtifacts,
      db.mockSectionState,
      db.learningEvents,
      db.vaultHealthSnapshots,
      db.rollbackSnapshots,
      db.calculatorScenarios,
      db.releaseRunHistory,
      db.importJobs,
      db.sourceBundleManifests,
      db.psychometricStats,
      db.mockBlueprints,
      db.notes,
      db.bookmarks,
      db.settings,
      ...(importOptions.includeSourceVault
        ? [db.sourceDocuments, db.sourceChunks, db.sourceIndexes, db.sourceIngestionRuns, db.sourceLinks, db.sourceLinkOverrides]
        : []),
    ],
    async () => {
      if (importOptions.mode === 'replace') {
        await Promise.all(STORE_NAMES.map((storeName) => db[storeName].clear()));
        if (importOptions.includeSourceVault) {
          await Promise.all(SOURCE_STORE_NAMES.map((storeName) => db[storeName].clear()));
        }
      }

      await Promise.all([
        db.lessonProgress.bulkPut(storesToWrite.lessonProgress),
        db.quizAttempts.bulkPut(storesToWrite.quizAttempts),
        db.questionResults.bulkPut(storesToWrite.questionResults),
        db.reviewItems.bulkPut(storesToWrite.reviewItems),
        db.masterySnapshots.bulkPut(storesToWrite.masterySnapshots),
        db.mockAttempts.bulkPut(storesToWrite.mockAttempts),
        db.vignetteAttempts.bulkPut(storesToWrite.vignetteAttempts),
        db.constructedResponseAttempts.bulkPut(storesToWrite.constructedResponseAttempts),
        db.formulaDrillAttempts.bulkPut(storesToWrite.formulaDrillAttempts),
        db.skillLabAttempts.bulkPut(storesToWrite.skillLabAttempts),
        db.studySessions.bulkPut(storesToWrite.studySessions),
        db.studyPlanSettings.bulkPut(storesToWrite.studyPlanSettings),
        db.contentVersions.bulkPut(storesToWrite.contentVersions),
        db.reviewEvents.bulkPut(storesToWrite.reviewEvents),
        db.confidenceCalibration.bulkPut(storesToWrite.confidenceCalibration),
        db.flashcardAttempts.bulkPut(storesToWrite.flashcardAttempts),
        db.resultArtifacts.bulkPut(storesToWrite.resultArtifacts),
        db.mockSectionState.bulkPut(storesToWrite.mockSectionState),
        db.learningEvents.bulkPut(storesToWrite.learningEvents),
        db.vaultHealthSnapshots.bulkPut(storesToWrite.vaultHealthSnapshots),
        db.rollbackSnapshots.bulkPut(storesToWrite.rollbackSnapshots),
        db.calculatorScenarios.bulkPut(storesToWrite.calculatorScenarios),
        db.releaseRunHistory.bulkPut(storesToWrite.releaseRunHistory),
        db.importJobs.bulkPut(storesToWrite.importJobs),
        db.sourceBundleManifests.bulkPut(storesToWrite.sourceBundleManifests),
        db.psychometricStats.bulkPut(storesToWrite.psychometricStats),
        db.mockBlueprints.bulkPut(storesToWrite.mockBlueprints),
        db.notes.bulkPut(storesToWrite.notes),
        db.bookmarks.bulkPut(storesToWrite.bookmarks),
        db.settings.bulkPut(storesToWrite.settings),
        ...(importOptions.includeSourceVault && exportPayload.sourceVault
          ? [
              db.sourceDocuments.bulkPut(exportPayload.sourceVault.sourceDocuments),
              db.sourceChunks.bulkPut(exportPayload.sourceVault.sourceChunks),
              db.sourceIndexes.bulkPut(exportPayload.sourceVault.sourceIndexes),
              db.sourceIngestionRuns.bulkPut(exportPayload.sourceVault.sourceIngestionRuns),
              db.sourceLinks.bulkPut(exportPayload.sourceVault.sourceLinks || []),
              db.sourceLinkOverrides.bulkPut(exportPayload.sourceVault.sourceLinkOverrides || []),
            ]
          : []),
      ]);
      if (rollbackSnapshot) await db.rollbackSnapshots.put(rollbackSnapshot);
    },
  );

  await appendVaultImportHistory({
    exportPayload,
    mode: importOptions.mode,
    conflictPolicy: importOptions.conflictPolicy,
    encrypted,
  });
  await db.importJobs.put({
    id: importJobId,
    startedAt: importStartedAt,
    completedAt: nowIso(),
    status: 'ok',
    mode: importOptions.mode,
    conflictPolicy: importOptions.conflictPolicy,
    encrypted,
    includeSourceVault: importOptions.includeSourceVault,
    exportId: exportPayload.exportId,
    rowCounts: vaultRowCounts(exportPayload.stores),
    sourceRowCounts: sourceVaultRowCounts(exportPayload.sourceVault),
    errors: [],
    rollbackSnapshotId: rollbackSnapshot?.id,
  });
  await rebuildLearningIndexes({ emit: false });
  emitProgressChange();
}

export async function recordSession({
  domain,
  topic,
  mode,
  startedAt,
  endedAt,
  elapsedSeconds,
  questionsAnswered = 0,
  score = 0,
}: Omit<StudySession, 'id'>) {
  const timestamp = nowIso();
  await db.studySessions.add({
    domain,
    topic,
    mode,
    startedAt: startedAt || timestamp,
    endedAt: endedAt || timestamp,
    elapsedSeconds,
    questionsAnswered,
    score,
  });
  emitProgressChange();
}

export async function recordStudyEvent(event: Omit<StudySession, 'id'>) {
  return recordSession(event);
}

export async function recordLearningEventEnvelope(envelope: LearningEventEnvelope) {
  await db.transaction('rw', [db.learningEvents, db.studySessions, db.reviewEvents], async () => {
    await db.learningEvents.put(envelope);
    await db.studySessions.add({
      domain: envelope.event.domain,
      topic: envelope.event.topic,
      mode: envelope.event.mode,
      startedAt: envelope.event.createdAt,
      endedAt: envelope.event.createdAt,
      elapsedSeconds: envelope.event.elapsedSeconds || 0,
      questionsAnswered: envelope.event.total || 0,
      score: envelope.event.total ? Math.round(((envelope.event.score || 0) / envelope.event.total) * 100) : envelope.event.score || 0,
    });
    await db.reviewEvents.add({
      domain: envelope.event.domain,
      topic: envelope.event.topic,
      learningObjective: envelope.sourceIds[0] || envelope.event.sourceId || `${envelope.event.sourceType}:unmapped`,
      eventType: 'completed',
      reviewItemId: envelope.event.sourceId || envelope.id,
      createdAt: envelope.recordedAt,
    });
  });
  emitProgressChange();
}

export async function recordContentVersion(version: Omit<ContentVersion, 'updatedAt'>) {
  const row: ContentVersion = {
    ...version,
    updatedAt: nowIso(),
  };
  await db.contentVersions.put(row);
  emitProgressChange();
  return row;
}

function artifactIdFor(type: ResultArtifact['type'], title: string) {
  return `${type}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}:${Date.now()}`;
}

export async function saveResultArtifact({
  type,
  domain,
  level,
  topic,
  title,
  summary,
  assumptions,
  metrics,
  path,
  noteId,
  objectiveIds,
}: Omit<ResultArtifact, 'id' | 'createdAt'>) {
  const artifact: ResultArtifact = {
    id: artifactIdFor(type, title),
    type,
    domain,
    level,
    topic,
    title,
    summary,
    assumptions,
    metrics,
    path,
    noteId,
    objectiveIds,
    createdAt: nowIso(),
  };
  await db.resultArtifacts.put(artifact);
  emitProgressChange();
  return artifact;
}

export async function getResultArtifacts(type?: ResultArtifact['type']) {
  const artifacts = await db.resultArtifacts.orderBy('createdAt').reverse().toArray();
  return type ? artifacts.filter((artifact) => artifact.type === type) : artifacts;
}

export async function deleteResultArtifact(id: string) {
  await db.resultArtifacts.delete(id);
  emitProgressChange();
}

export async function saveMockSectionState(state: Omit<MockSectionState, 'updatedAt' | 'expiresAt'>) {
  const timestamp = nowIso();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const row: MockSectionState = {
    ...state,
    updatedAt: timestamp,
    expiresAt: expires,
  };
  await db.mockSectionState.put(row);
  emitProgressChange();
  return row;
}

export async function getMockSectionState(id = 'cfa-level1-mixed-mock') {
  const state = await db.mockSectionState.get(id);
  if (!state) return null;
  if (new Date(state.expiresAt).getTime() < Date.now()) {
    await db.mockSectionState.delete(id);
    return null;
  }
  return state;
}

export async function clearMockSectionState(id = 'cfa-level1-mixed-mock') {
  await db.mockSectionState.delete(id);
  emitProgressChange();
}

export async function recordFlashcardResult({
  domain = 'cfa',
  topic,
  cardId,
  cardType,
  title,
  path = '/flashcards',
  outcome,
  elapsedSeconds = 20,
}: {
  domain?: DomainId;
  topic: string;
  cardId: string;
  cardType: FlashcardAttempt['cardType'];
  title: string;
  path?: string;
  outcome: FlashcardAttempt['outcome'];
  elapsedSeconds?: number;
}) {
  const timestamp = nowIso();
  const correct = outcome === 'known';
  const result = normalizeQuestionResult(
    {
      domain,
      topic,
      questionId: cardId,
      learningObjective: `flashcard:${cardId}`,
      correct,
      confidence: correct ? 'high' : 'low',
      errorCategory: correct ? 'none' : 'concept',
      difficulty: 'foundation',
      elapsedSeconds,
      title,
      objectiveTitle: title,
      path,
      createdAt: timestamp,
    },
    timestamp,
  );

  await db.transaction(
    'rw',
    [
      db.flashcardAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.flashcardAttempts.add({
        domain,
        topic,
        cardId,
        cardType,
        outcome,
        elapsedSeconds,
        createdAt: timestamp,
      });
      await persistQuestionResult(result);
      await db.studySessions.add({
        domain,
        topic,
        mode: 'flashcard-drill',
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: 1,
        score: correct ? 100 : 0,
      });
    },
  );

  emitProgressChange();
}

function daysBetween(from: Date, to: Date) {
  return Math.max(0, (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function scoreVolatility(scores: number[]) {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  return Math.round(Math.sqrt(variance));
}

export async function getReadinessByTopic(dateOrOptions: Date | Level3PathwayQuery = new Date(), maybeOptions: Level3PathwayQuery = {}): Promise<TopicReadiness[]> {
  const date = dateOrOptions instanceof Date ? dateOrOptions : new Date();
  const options = dateOrOptions instanceof Date ? maybeOptions : dateOrOptions;
  const [snapshots, reviewItems, results] = await Promise.all([
    db.masterySnapshots.toArray(),
    db.reviewItems.toArray(),
    db.questionResults.toArray(),
  ]);
  const grouped = new Map<string, MasterySnapshot[]>();
  snapshots.filter((snapshot) => level3TopicRowAllowed(snapshot, options.level3Pathway)).forEach((snapshot) => {
    const key = `${snapshot.domain}:${snapshot.topic}`;
    grouped.set(key, [...(grouped.get(key) || []), snapshot]);
  });

  return [...grouped.entries()]
    .map(([key, topicSnapshots]) => {
      const [domainPart, ...topicParts] = key.split(':');
      const domain = domainPart as DomainId;
      const topic = topicParts.join(':');
      const topicResults = results.filter((result) => result.domain === domain && result.topic === topic && level3TopicRowAllowed(result, options.level3Pathway));
      const topicReviews = reviewItems.filter((item) => item.domain === domain && item.topic === topic && level3TopicRowAllowed(item, options.level3Pathway));
      const dueCount = topicReviews.filter((item) => isDue(item, date)).length;
      const averageMastery = Math.round(
        topicSnapshots.reduce((sum, snapshot) => sum + snapshot.score, 0) / Math.max(1, topicSnapshots.length),
      );
      const lastAttempt = topicSnapshots
        .map((snapshot) => snapshot.lastAttemptAt)
        .sort()
        .at(-1);
      const daysStale = lastAttempt ? daysBetween(new Date(lastAttempt), date) : 0;
      const retentionDecay = Math.min(35, Math.round(daysStale * 0.9));
      const volatility = scoreVolatility(topicSnapshots.map((snapshot) => snapshot.score));
      const reviewDebt = Math.min(40, dueCount * 8);
      const confidenceMean =
        topicResults.reduce((sum, result) => sum + CONFIDENCE_SCORE[result.confidence], 0) / Math.max(1, topicResults.length);
      const accuracy = (topicResults.filter((result) => result.correct).length / Math.max(1, topicResults.length)) * 100;
      const confidenceCalibration = Math.round(Math.max(-40, Math.min(40, confidenceMean - accuracy)));
      const readinessScore = Math.max(
        0,
        Math.min(100, Math.round(averageMastery - retentionDecay - reviewDebt - volatility * 0.25 - Math.max(0, confidenceCalibration) * 0.25)),
      );
      const trendScores = topicSnapshots.map((snapshot) => snapshot.trend);
      const trend: TopicReadiness['trend'] = trendScores.includes('up')
        ? 'up'
        : trendScores.includes('down')
          ? 'down'
          : trendScores.includes('flat')
            ? 'flat'
            : 'new';

      return {
        id: key,
        domain,
        topic,
        title: topicSnapshots[0]?.title || topic,
        readinessScore,
        averageMastery,
        volatility,
        retentionDecay,
        reviewDebt,
        confidenceCalibration,
        attempts: topicResults.length,
        dueCount,
        trend,
      };
    })
    .sort((a, b) => a.readinessScore - b.readinessScore);
}

export async function forecastReviewLoad(days = 14, date = new Date(), options: Level3PathwayQuery = {}): Promise<RetentionForecast[]> {
  const reviewItems = await db.reviewItems.toArray();
  const visibleItems = reviewItems.filter((item) => level3TopicRowAllowed(item, options.level3Pathway));
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(date);
    day.setDate(date.getDate() + index);
    const key = day.toISOString().slice(0, 10);
    const dueItems = visibleItems.filter((item) => item.dueAt.slice(0, 10) === key);
    const retention = dueItems.length
      ? Math.round((dueItems.reduce((sum, item) => sum + predictRetention(item, day), 0) / dueItems.length) * 100)
      : null;
    return {
      date: key,
      count: dueItems.length,
      averageRetention: retention,
      atRiskCount: dueItems.filter((item) => predictRetention(item, day) < 0.72).length,
    };
  });
}

function topicWeightFor(topicWeights: Record<string, number> | undefined, topic?: string) {
  if (!topic || !topicWeights) return 0;
  return Number(topicWeights[topic] ?? topicWeights[topic.split(':').at(-1) || topic] ?? 0) || 0;
}

const ITEM_TYPE_WEIGHTS: Record<string, number> = {
  'constructed-response': 1.45,
  mock: 1.3,
  vignette: 1.2,
  'quant-lab': 1.18,
  'excel-drill': 1.14,
  calculator: 1.12,
  'formula-drill': 1.08,
  flashcard: 1.04,
  single: 1,
};

function itemTypeWeightFor(itemType?: string) {
  return ITEM_TYPE_WEIGHTS[itemType || 'single'] ?? 1;
}

function itemTypeLabel(itemType?: string) {
  return (itemType || 'single').replace(/-/g, ' ');
}

function weightedAccuracyFor(results: QuestionResultRow[]) {
  if (!results.length) return 100;
  const totalWeight = results.reduce((sum, result) => sum + itemTypeWeightFor(result.itemType), 0);
  const earnedWeight = results.reduce((sum, result) => sum + (result.correct ? itemTypeWeightFor(result.itemType) : 0), 0);
  return Math.round((earnedWeight / Math.max(1, totalWeight)) * 100);
}

function impactFromScore(score: number, weight = 1) {
  return Math.max(0, Math.round((100 - score) * weight));
}

function lowestRubricSignals(attempts: ConstructedResponseAttempt[], topic?: string, limit = 3) {
  const relevant = topic ? attempts.filter((attempt) => attempt.topic === topic) : attempts;
  const rubricKeys = [...new Set(relevant.flatMap((attempt) => Object.keys(attempt.rubricScores || {})))].sort();
  return rubricKeys
    .map((criterion) => {
      const scores = relevant.map((attempt) => Math.round(((attempt.rubricScores[criterion] ?? 0) / 2) * 100));
      const averagePct = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
      return {
        criterion,
        attempts: scores.length,
        averagePct,
        impact: impactFromScore(averagePct, 0.35),
      };
    })
    .filter((row) => row.attempts > 0 && row.averagePct < 75)
    .sort((a, b) => b.impact - a.impact || a.averagePct - b.averagePct)
    .slice(0, limit);
}

function artifactObjectiveImpacts(artifacts: ResultArtifact[], skillLabAttempts: SkillLabAttempt[]) {
  const grouped = new Map<string, { objectiveId: string; topic?: string; sourceType: string; scores: number[] }>();
  const add = (objectiveId: string, topic: string | undefined, sourceType: string, score: number) => {
    const key = `${sourceType}:${topic || 'unmapped'}:${objectiveId}`;
    const row = grouped.get(key) || { objectiveId, topic, sourceType, scores: [] };
    row.scores.push(score);
    grouped.set(key, row);
  };

  artifacts.forEach((artifact) => {
    const metricScore = Number(artifact.metrics.score ?? artifact.metrics.accuracy ?? artifact.metrics.pct);
    const score = Number.isFinite(metricScore) ? Math.max(0, Math.min(100, metricScore)) : 100;
    artifact.objectiveIds?.forEach((objectiveId) => add(objectiveId, artifact.topic, artifact.type, score));
  });
  skillLabAttempts.forEach((attempt) => {
    const score = Math.max(0, Math.min(100, Number(attempt.score ?? 100)));
    attempt.objectiveIds.forEach((objectiveId) => add(objectiveId, attempt.topic, attempt.labType, score));
  });

  return [...grouped.values()]
    .map((row) => {
      const averageScore = Math.round(row.scores.reduce((sum, score) => sum + score, 0) / Math.max(1, row.scores.length));
      return {
        objectiveId: row.objectiveId,
        topic: row.topic,
        sourceType: row.sourceType,
        attempts: row.scores.length,
        averageScore,
        impact: impactFromScore(averageScore, row.sourceType === 'calculator' ? 0.22 : 0.3),
      };
    })
    .filter((row) => row.impact > 0)
    .sort((a, b) => b.impact - a.impact || a.averageScore - b.averageScore);
}

function explainReviewReason(reason: ReviewReason, context: { score?: number; retentionPct?: number; topicWeight?: number; itemType?: string } = {}) {
  const details: string[] = [];
  if (reason === 'due-review') details.push(`Retention forecast is ${context.retentionPct ?? 'below target'}%.`);
  if (reason === 'weak-objective') details.push(`Readiness is ${context.score ?? 'below target'}%.`);
  if (reason === 'rubric-miss') details.push('Constructed-response rubric bands are below the command-word target.');
  if (reason === 'skill-lab-gap') details.push(`${context.itemType ? itemTypeLabel(context.itemType) : 'Lab'} practice is below target.`);
  if (reason === 'stale-topic') details.push('Prior evidence has decayed or accumulated review debt.');
  if (reason === 'missed-question') details.push('The latest evidence includes an incorrect answer.');
  if (reason === 'flashcard-decay') details.push('Recall evidence needs another retrieval rep.');
  if (reason === 'unfinished-lesson') details.push('Started lesson progress has not been completed.');
  if (reason === 'saved-artifact') details.push('Saved vault artifact is available for follow-up.');
  if ((context.topicWeight ?? 0) >= 12) details.push(`Topic carries ${context.topicWeight}% planning weight.`);
  return details;
}

const DEFAULT_CFA_TOPIC_WEIGHTS: Record<string, number> = {
  ethics: 20,
  'quant-methods': 9,
  economics: 9,
  fsa: 14,
  corporate: 9,
  equity: 14,
  'fixed-income': 14,
  derivatives: 8,
  alternatives: 10,
  portfolio: 12,
};

const DEFAULT_STUDY_PLAN_SETTINGS: StudyPlanSettings = {
  id: 'local-study-plan',
  targetLevel: 'level1',
  dailyTargetMinutes: 45,
  examDate: null,
  restDays: [],
  mockCadenceDays: 14,
  topicWeights: DEFAULT_CFA_TOPIC_WEIGHTS,
  updatedAt: '',
};

export async function getStudyPlanSettings(): Promise<StudyPlanSettings> {
  const existing = await db.studyPlanSettings.get('local-study-plan');
  return {
    ...DEFAULT_STUDY_PLAN_SETTINGS,
    ...existing,
    updatedAt: existing?.updatedAt || nowIso(),
  };
}

export async function saveStudyPlanSettings({
  targetLevel,
  dailyTargetMinutes,
  examDate = null,
  restDays = [],
  mockCadenceDays,
  topicWeights,
}: Partial<Omit<StudyPlanSettings, 'id' | 'updatedAt'>>) {
  const existing = await getStudyPlanSettings();
  const settings: StudyPlanSettings = {
    id: 'local-study-plan',
    targetLevel: targetLevel || existing.targetLevel || 'level1',
    dailyTargetMinutes: Math.max(10, Math.min(360, Number(dailyTargetMinutes ?? existing.dailyTargetMinutes) || 45)),
    examDate: examDate ?? existing.examDate ?? null,
    restDays: Array.isArray(restDays) ? restDays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [],
    mockCadenceDays: Math.max(3, Math.min(60, Number(mockCadenceDays ?? existing.mockCadenceDays) || 14)),
    topicWeights: topicWeights || existing.topicWeights || {},
    updatedAt: nowIso(),
  };
  await db.studyPlanSettings.put(settings);
  emitProgressChange();
  return settings;
}

/**
 * DATA-6 — map the host's `StudyPlanSettings` onto the cross-domain
 * {@link SharedStudyProfile} shape (used by `studyProfileBridge.ts` as the local
 * Dexie fallback). The host owns `targetLevel` / `dailyTargetMinutes` /
 * `examDate` / `restDays` / `mockCadenceDays` / `topicWeights`; it has no LSAT
 * `targetScore`, so that scalar keeps the shared default until the backend
 * arbiter (or the LSAT side) supplies one. `lastWriter` is `"host"` because this
 * projection represents a host-local view.
 */
export function studyPlanSettingsToProfile(settings: StudyPlanSettings): SharedStudyProfile {
  return {
    ...DEFAULT_SHARED_STUDY_PROFILE,
    targetLevel: settings.targetLevel ?? null,
    dailyMinutes: settings.dailyTargetMinutes ?? DEFAULT_SHARED_STUDY_PROFILE.dailyMinutes,
    examDate: settings.examDate ?? null,
    restDays: Array.isArray(settings.restDays) ? settings.restDays : [],
    mockCadenceDays: settings.mockCadenceDays ?? null,
    topicWeights: settings.topicWeights ?? {},
    lastWriter: 'host',
    updatedAt: settings.updatedAt || null,
  };
}

/**
 * DATA-6 — map a cross-domain {@link StudyProfilePatch} onto the host
 * `saveStudyPlanSettings` argument shape (the inverse of
 * {@link studyPlanSettingsToProfile}). Only the host-owned fields are carried
 * over; the LSAT-only `targetScore` is intentionally dropped (the host does not
 * store it). Used by `studyProfileBridge.ts` to dual-write a profile edit to
 * Dexie. Only keys present on the patch are forwarded so unset fields are not
 * overwritten.
 */
export function studyProfileToPlanSettingsPatch(
  patch: StudyProfilePatch,
): Partial<Omit<StudyPlanSettings, 'id' | 'updatedAt'>> {
  const out: Partial<Omit<StudyPlanSettings, 'id' | 'updatedAt'>> = {};
  if (patch.targetLevel !== undefined) out.targetLevel = patch.targetLevel ?? undefined;
  if (patch.dailyMinutes !== undefined) out.dailyTargetMinutes = patch.dailyMinutes;
  if (patch.examDate !== undefined) out.examDate = patch.examDate;
  if (patch.restDays !== undefined) out.restDays = patch.restDays;
  if (patch.mockCadenceDays !== undefined) out.mockCadenceDays = patch.mockCadenceDays ?? undefined;
  if (patch.topicWeights !== undefined) out.topicWeights = patch.topicWeights;
  return out;
}

export async function getStudyPlan({
  examDate,
  dailyTargetMinutes,
  targetLevel,
  level3Pathway,
}: {
  examDate?: string | null;
  dailyTargetMinutes?: number;
  targetLevel?: string;
  level3Pathway?: string;
} = {}): Promise<StudySessionPlan> {
  const [settings, dueReviews, forecast, readiness, objectiveReadiness, recommendation] = await Promise.all([
    getStudyPlanSettings(),
    getDueReviews(new Date(), { level3Pathway }),
    forecastReviewLoad(14, new Date(), { level3Pathway }),
    getReadinessByTopic({ level3Pathway }),
    getReadinessByObjectiveV2({ level3Pathway }),
    getNextRecommendation({ level3Pathway }),
  ]);
  const effectiveExamDate = examDate !== undefined ? examDate : settings.examDate;
  const effectiveDailyTarget = dailyTargetMinutes ?? settings.dailyTargetMinutes;
  const effectiveTargetLevel = targetLevel || settings.targetLevel || 'level1';
  const daysToExam = effectiveExamDate ? Math.max(0, Math.ceil(daysBetween(new Date(), new Date(effectiveExamDate)))) : null;
  const weightedReadiness = [...readiness].sort(
    (a, b) =>
      a.readinessScore -
      topicWeightFor(settings.topicWeights, a.topic) * 0.4 -
      (b.readinessScore - topicWeightFor(settings.topicWeights, b.topic) * 0.4),
  );
  const weakest = weightedReadiness[0];
  const weakestObjective = objectiveReadiness[0];
  const recommendationReason: ReviewReason =
    recommendation.label === 'Review Due' ? 'due-review' : recommendation.label === 'Weak Area' ? 'weak-objective' : 'unfinished-lesson';

  return {
    id: 'local-study-plan',
    targetLevel: effectiveTargetLevel,
    dailyTargetMinutes: effectiveDailyTarget,
    examDate: effectiveExamDate,
    restDays: settings.restDays,
    mockCadenceDays: settings.mockCadenceDays,
    topicWeights: settings.topicWeights,
    daysToExam,
    dueToday: dueReviews.length,
    forecastReviewCount: forecast.reduce((sum, item) => sum + item.count, 0),
    nextActions: [
      {
        ...recommendation,
        reasonDetails: explainReviewReason(recommendationReason, {
          score: weakestObjective?.readinessScore,
          retentionPct: weakestObjective?.retentionForecastPct,
          topicWeight: weakestObjective?.topicWeight,
        }),
      },
      ...(weakest
        ? [
            {
              label: 'Readiness',
              title: weakestObjective?.title || weakest.title,
              path: defaultPathFor(weakestObjective?.domain || weakest.domain, weakestObjective?.topic || weakest.topic, 'weak-areas'),
              reason: weakestObjective
                ? `Objective readiness is ${weakestObjective.readinessScore}% after item-type, retention, rubric, and lab evidence.`
                : `Topic readiness is ${weakest.readinessScore}%.`,
              reasonDetails: weakestObjective?.reasonDetails || [
                `Topic readiness is ${weakest.readinessScore}%.`,
                `Planning weight is ${topicWeightFor(settings.topicWeights, weakest.topic)}%.`,
              ],
              reviewReason: weakestObjective?.primaryReason || ('weak-objective' as ReviewReason),
              estimatedMinutes: Math.min(30, Math.max(12, Math.round(effectiveDailyTarget * 0.35))),
            },
          ]
        : []),
    ],
    planVersion: 2,
    generatedForDate: new Date().toISOString().slice(0, 10),
    focusLevel: effectiveTargetLevel,
    budgetMinutes: effectiveDailyTarget,
    reviewLoad: forecast,
    updatedAt: nowIso(),
  };
}

export async function getReviewInbox(options: Level3PathwayQuery = {}): Promise<ReviewQueueItem[]> {
  const [
    dueReviews,
    mastery,
    results,
    bookmarks,
    lessonProgress,
    readiness,
    mockAttempts,
    vignetteAttempts,
    constructedResponseAttempts,
    formulaDrillAttempts,
    skillLabAttempts,
    artifacts,
  ] = await Promise.all([
    getDueReviews(new Date(), options),
    getMasterySummary(options),
    db.questionResults.orderBy('createdAt').reverse().toArray(),
    db.bookmarks.toArray(),
    db.lessonProgress.toArray(),
    getReadinessByTopic(options),
    db.mockAttempts.orderBy('createdAt').reverse().toArray(),
    db.vignetteAttempts.orderBy('createdAt').reverse().toArray(),
    db.constructedResponseAttempts.orderBy('createdAt').reverse().toArray(),
    db.formulaDrillAttempts.orderBy('createdAt').reverse().toArray(),
    db.skillLabAttempts.orderBy('createdAt').reverse().toArray(),
    db.resultArtifacts.orderBy('createdAt').reverse().toArray(),
  ]);
  const visibleResults = results.filter((result) => level3TopicRowAllowed(result, options.level3Pathway));
  const visibleBookmarks = bookmarks.filter((item) => level3TopicRowAllowed({ topic: item.moduleId }, options.level3Pathway));
  const visibleLessonProgress = lessonProgress.filter((item) => level3TopicRowAllowed({ topic: item.moduleId }, options.level3Pathway));
  const visibleMockAttempts = mockAttempts.filter((attempt) => level3MockAttemptAllowed(attempt, options.level3Pathway));
  const visibleVignetteAttempts = vignetteAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleConstructedResponseAttempts = constructedResponseAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleFormulaDrillAttempts = formulaDrillAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleSkillLabAttempts = skillLabAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleArtifacts = artifacts.filter((artifact) => level3TopicRowAllowed(artifact, options.level3Pathway));
  const latestWrongByQuestion = new Map<string, QuestionResultRow>();
  visibleResults.forEach((result) => {
    const key = `${result.domain}:${result.topic}:${result.questionId}`;
    if (!result.correct && !latestWrongByQuestion.has(key)) latestWrongByQuestion.set(key, result);
  });
  const objectiveReadiness = await getReadinessByObjectiveV2();
  const readinessById = new Map(objectiveReadiness.map((item) => [item.id, item]));
  const rubricSignalsByTopic = new Map<string, ReturnType<typeof lowestRubricSignals>>();
  constructedResponseAttempts.forEach((attempt) => {
    if (!rubricSignalsByTopic.has(attempt.topic)) {
      rubricSignalsByTopic.set(attempt.topic, lowestRubricSignals(constructedResponseAttempts, attempt.topic));
    }
  });
  const artifactImpacts = artifactObjectiveImpacts(artifacts, skillLabAttempts);

  const items: ReviewQueueItem[] = [
    ...dueReviews.map((item) => ({
      id: `due:${item.id}`,
      type: 'due-review' as const,
      title: item.title,
      subtitle: `Due ${new Date(item.dueAt).toLocaleDateString()} - ${item.lastConfidence} confidence`,
      path: item.path,
      priority: 100 - item.ease * 10,
      dueAt: item.dueAt,
      topic: item.topic,
      reason: 'due-review' as const,
      retentionPct: Math.round(predictRetention(item, new Date()) * 100),
      sourceIds: [item.id, item.learningObjective],
      reasonDetails: explainReviewReason('due-review', {
        retentionPct: Math.round(predictRetention(item, new Date()) * 100),
        topicWeight: readinessById.get(item.id)?.topicWeight,
      }),
      weaknessSignals: readinessById.get(item.id)?.weaknessSignals.map((signal) => ({ label: signal.label, impact: signal.impact })),
    })),
    ...mastery.weakObjectives.map((item) => ({
      id: `weak:${item.id}`,
      type: 'weak-objective' as const,
      title: item.title,
      subtitle: `${item.score}% mastery across ${item.attempts} attempts`,
      path: defaultPathFor(item.domain, item.topic, 'weak-areas'),
      priority: 85 - item.score,
      topic: item.topic,
      reason: 'weak-objective' as const,
      sourceIds: [item.id],
      reasonDetails: readinessById.get(item.id)?.reasonDetails || explainReviewReason('weak-objective', { score: item.score }),
      weaknessSignals: readinessById.get(item.id)?.weaknessSignals.map((signal) => ({ label: signal.label, impact: signal.impact })),
    })),
    ...[...latestWrongByQuestion.values()].slice(0, 12).map((item) => ({
      id: `miss:${item.domain}:${item.topic}:${item.questionId}`,
      type: 'missed-question' as const,
      title: item.title || item.questionId,
      subtitle: `Missed question - ${item.errorCategory}`,
      path: item.path || defaultPathFor(item.domain, item.topic, 'review-due'),
      priority: 72,
      topic: item.topic,
      reason: 'missed-question' as const,
      sourceIds: [item.questionId, item.learningObjective],
      reasonDetails: explainReviewReason('missed-question', {
        itemType: item.itemType,
        topicWeight: topicWeightFor(DEFAULT_STUDY_PLAN_SETTINGS.topicWeights, item.topic),
      }),
    })),
    ...visibleBookmarks.map((item) => ({
      id: `bookmark:${item.id}`,
      type: 'bookmark' as const,
      title: item.title,
      subtitle: `${item.type} bookmark`,
      path: item.path,
      priority: 45,
      topic: item.moduleId,
      reason: 'saved-artifact' as const,
      sourceIds: [item.id],
    })),
    ...readiness
      .filter((item) => item.retentionDecay >= 14 || item.reviewDebt > 0)
      .slice(0, 8)
      .map((item) => ({
        id: `stale:${item.id}`,
        type: 'stale-topic' as const,
        title: item.title,
        subtitle: `${item.readinessScore}% readiness - review debt ${item.reviewDebt}`,
        path: defaultPathFor(item.domain, item.topic, 'review-due'),
        priority: 60 - item.readinessScore,
        topic: item.topic,
      reason: 'stale-topic' as const,
      sourceIds: [item.id],
      reasonDetails: explainReviewReason('stale-topic', {
        score: item.readinessScore,
        topicWeight: topicWeightFor(DEFAULT_STUDY_PLAN_SETTINGS.topicWeights, item.topic),
      }),
    })),
    ...visibleMockAttempts
      .filter((attempt) => attempt.pct < 70 || attempt.flaggedQuestionIds.length > 0)
      .slice(0, 6)
      .map((attempt) => ({
        id: `mock-review:${attempt.id || attempt.createdAt}`,
        type: 'mock-review' as const,
        title: attempt.title,
        subtitle: `${attempt.pct}% score - ${attempt.flaggedQuestionIds.length} flagged`,
        path: '/cfa/mock',
        priority: 68 - attempt.pct * 0.25 + attempt.flaggedQuestionIds.length,
        topic: 'mock',
        reason: attempt.flaggedQuestionIds.length ? ('flagged-mock-item' as const) : ('missed-question' as const),
        sourceIds: attempt.flaggedQuestionIds,
        reasonDetails: [
          `${attempt.pct}% mock score.`,
          attempt.flaggedQuestionIds.length
            ? `${attempt.flaggedQuestionIds.length} flagged item${attempt.flaggedQuestionIds.length === 1 ? '' : 's'}.`
            : 'Score is below the mock review threshold.',
        ],
      })),
    ...visibleVignetteAttempts
      .filter((attempt) => attempt.pct < 72)
      .slice(0, 6)
      .map((attempt) => ({
        id: `vignette-review:${attempt.id || attempt.createdAt}`,
        type: 'missed-question' as const,
        title: attempt.title,
        subtitle: `${attempt.pct}% vignette score - review item-set logic`,
        path: `/cfa/${attempt.level}/${attempt.topic.split(':').at(-1)}/vignette`,
        priority: 70 - attempt.pct * 0.2,
        topic: attempt.topic,
        reason: 'missed-question' as const,
        sourceIds: [attempt.vignetteId],
        reasonDetails: [`${attempt.pct}% item-set score.`, 'Vignette evidence has higher readiness weight than standalone quiz rows.'],
      })),
    ...visibleConstructedResponseAttempts
      .filter((attempt) => attempt.pct < 75)
      .slice(0, 6)
      .map((attempt) => ({
        id: `essay-review:${attempt.id || attempt.createdAt}`,
        type: 'weak-objective' as const,
        title: attempt.title,
        subtitle: `${attempt.pct}% rubric score - revisit command words`,
        path: `/cfa/${attempt.level}/${attempt.topic.split(':').at(-1)}/constructed-response`,
        priority: 74 - attempt.pct * 0.2,
        topic: attempt.topic,
        reason: 'rubric-miss' as const,
        sourceIds: [attempt.itemId],
        reasonDetails: [
          `${attempt.pct}% constructed-response score.`,
          ...(rubricSignalsByTopic.get(attempt.topic) || []).map((signal) => `${signal.criterion} rubric average is ${signal.averagePct}%.`),
        ],
        weaknessSignals: (rubricSignalsByTopic.get(attempt.topic) || []).map((signal) => ({
          label: `${signal.criterion} rubric`,
          impact: signal.impact,
        })),
      })),
    ...visibleFormulaDrillAttempts
      .filter((attempt) => !attempt.correct)
      .slice(0, 8)
      .map((attempt) => ({
        id: `formula-drill:${attempt.id || attempt.createdAt}`,
        type: 'flashcard-review' as const,
        title: attempt.formulaName,
        subtitle: `${attempt.confidence} confidence formula miss`,
        path: '/flashcards',
        priority: 66,
        topic: attempt.topic,
        reason: 'flashcard-decay' as const,
        sourceIds: [attempt.formulaName],
        reasonDetails: explainReviewReason('flashcard-decay', { itemType: 'formula-drill' }),
      })),
    ...visibleSkillLabAttempts
      .filter((attempt) => (attempt.score ?? 100) < 75)
      .slice(0, 6)
      .map((attempt) => ({
        id: `skill-lab:${attempt.id || attempt.createdAt}`,
        type: 'stale-topic' as const,
        title: attempt.labId,
        subtitle: `${attempt.labType} needs another active rep`,
        path: defaultPathFor(attempt.domain, attempt.topic, 'weak-areas'),
        priority: 52,
        topic: attempt.topic,
        reason: 'skill-lab-gap' as const,
        sourceIds: [attempt.labId, attempt.artifactId].filter(Boolean) as string[],
        reasonDetails: [
          `${attempt.labType} score is ${attempt.score ?? 100}%.`,
          ...artifactImpacts
            .filter((impact) => attempt.objectiveIds.includes(impact.objectiveId))
            .slice(0, 2)
            .map((impact) => `${impact.sourceType} maps to ${impact.objectiveId} at ${impact.averageScore}%.`),
        ],
        weaknessSignals: artifactImpacts
          .filter((impact) => attempt.objectiveIds.includes(impact.objectiveId))
          .slice(0, 3)
          .map((impact) => ({ label: `${impact.sourceType} objective impact`, impact: impact.impact })),
      })),
    ...visibleArtifacts.slice(0, 6).map((artifact) => ({
      id: `artifact:${artifact.id}`,
      type: 'bookmark' as const,
      title: artifact.title,
      subtitle: `${artifact.type} artifact saved to vault`,
      path: artifact.path || '/vault',
      priority: 38,
      topic: artifact.topic,
      reason: 'saved-artifact' as const,
      sourceIds: [artifact.id],
      reasonDetails: artifact.objectiveIds?.length
        ? [`Maps to ${artifact.objectiveIds.length} objective${artifact.objectiveIds.length === 1 ? '' : 's'}.`]
        : explainReviewReason('saved-artifact'),
    })),
    ...visibleLessonProgress
      .filter((item) => !item.completed)
      .slice(0, 8)
      .map((item) => ({
        id: `lesson:${item.id}`,
        type: 'unfinished-lesson' as const,
        title: item.title,
        subtitle: `${item.visitCount} visit${item.visitCount === 1 ? '' : 's'} - not completed`,
        path: item.path,
        priority: 35,
        topic: item.moduleId,
        reason: 'unfinished-lesson' as const,
        sourceIds: [item.id],
        reasonDetails: explainReviewReason('unfinished-lesson'),
      })),
  ];

  return items.sort((a, b) => b.priority - a.priority).slice(0, 40);
}

function accuracyFor(results: QuestionResultRow[]) {
  return Math.round((results.filter((result) => result.correct).length / Math.max(1, results.length)) * 100);
}

function trendForResults(results: QuestionResultRow[]): 'new' | 'up' | 'flat' | 'down' {
  if (results.length < 4) return results.length ? 'new' : 'flat';
  const ordered = [...results].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const midpoint = Math.floor(ordered.length / 2);
  const earlier = accuracyFor(ordered.slice(0, midpoint));
  const later = accuracyFor(ordered.slice(midpoint));
  if (later > earlier + 5) return 'up';
  if (later < earlier - 5) return 'down';
  return 'flat';
}

function confidenceCalibrationSummary(rows: ConfidenceCalibration[]): ConfidenceCalibrationSummary[] {
  return CONFIDENCES.map((confidence) => {
    const bucket = rows.filter((row) => row.confidence === confidence);
    const accuracy = accuracyFor(bucket as QuestionResultRow[]);
    return {
      confidence,
      attempts: bucket.length,
      accuracy,
      calibrationGap: Math.round(CONFIDENCE_SCORE[confidence] - accuracy),
    };
  });
}

export async function getConfidenceCalibration(): Promise<ConfidenceCalibrationSummary[]> {
  return confidenceCalibrationSummary(await db.confidenceCalibration.toArray());
}

export async function getAnalyticsSummary(options: Level3PathwayQuery = {}): Promise<AnalyticsSummary> {
  const [
    results,
    sessions,
    mockAttempts,
    vignetteAttempts,
    constructedResponseAttempts,
    formulaDrillAttempts,
    skillLabAttempts,
    flashcardAttempts,
    artifacts,
    confidenceCalibrationRows,
  ] = await Promise.all([
    db.questionResults.toArray(),
    db.studySessions.toArray(),
    db.mockAttempts.toArray(),
    db.vignetteAttempts.toArray(),
    db.constructedResponseAttempts.toArray(),
    db.formulaDrillAttempts.toArray(),
    db.skillLabAttempts.toArray(),
    db.flashcardAttempts.toArray(),
    db.resultArtifacts.toArray(),
    db.confidenceCalibration.toArray(),
  ]);
  const visibleResults = results.filter((result) => level3TopicRowAllowed(result, options.level3Pathway));
  const visibleSessions = sessions.filter((session) => level3TopicRowAllowed(session, options.level3Pathway));
  const visibleMockAttempts = mockAttempts.filter((attempt) => level3MockAttemptAllowed(attempt, options.level3Pathway));
  const visibleVignetteAttempts = vignetteAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleConstructedResponseAttempts = constructedResponseAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleFormulaDrillAttempts = formulaDrillAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleSkillLabAttempts = skillLabAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleFlashcardAttempts = flashcardAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleArtifacts = artifacts.filter((artifact) => level3TopicRowAllowed(artifact, options.level3Pathway));
  const confidenceCalibration = confidenceCalibrationSummary(confidenceCalibrationRows.filter((row) => level3TopicRowAllowed(row, options.level3Pathway)));

  const topics = [...new Set(visibleResults.map((result) => result.topic))].sort();
  const byTopic = topics.map((topic) => {
    const topicResults = visibleResults.filter((result) => result.topic === topic);
    const confidenceAverage = Math.round(
      topicResults.reduce((sum, result) => sum + CONFIDENCE_SCORE[result.confidence], 0) / Math.max(1, topicResults.length),
    );
    const elapsedAverage = Math.round(
      topicResults.reduce((sum, result) => sum + (result.elapsedSeconds || 0), 0) / Math.max(1, topicResults.length),
    );
    return {
      topic,
      attempts: topicResults.length,
      accuracy: accuracyFor(topicResults),
      averageConfidence: confidenceAverage,
      averageElapsedSeconds: elapsedAverage,
      formulaDependency: Math.round(
        (topicResults.filter((result) => Boolean(result.formula)).length / Math.max(1, topicResults.length)) * 100,
      ),
      timePressureErrors: topicResults.filter((result) => result.errorCategory === 'time-pressure').length,
      recentTrend: trendForResults(topicResults),
    };
  });

  const byDifficulty = DIFFICULTIES.map((difficulty) => {
    const bucket = visibleResults.filter((result) => result.difficulty === difficulty);
    return { difficulty, attempts: bucket.length, accuracy: accuracyFor(bucket) };
  });

  const byErrorCategory = ERROR_CATEGORIES.map((errorCategory) => ({
    errorCategory,
    attempts: visibleResults.filter((result) => result.errorCategory === errorCategory).length,
  })).filter((row) => row.attempts > 0 || row.errorCategory === 'none');

  const rollingTrend = [...new Set(visibleResults.map((result) => result.createdAt.slice(0, 10)))]
    .sort()
    .slice(-14)
    .map((date) => {
      const bucket = visibleResults.filter((result) => result.createdAt.slice(0, 10) === date);
      return { date, attempts: bucket.length, accuracy: accuracyFor(bucket) };
    });

  const byLevel = [...new Set(visibleResults.map((result) => result.level || (result.topic.includes(':') ? result.topic.split(':')[0] : 'level1')))]
    .sort()
    .map((level) => {
      const bucket = visibleResults.filter((result) => (result.level || (result.topic.includes(':') ? result.topic.split(':')[0] : 'level1')) === level);
      return { level, attempts: bucket.length, accuracy: accuracyFor(bucket) };
    });

  const byObjective = [...new Set(visibleResults.map((result) => result.learningObjective))]
    .sort()
    .slice(0, 30)
    .map((objectiveId) => {
      const bucket = visibleResults.filter((result) => result.learningObjective === objectiveId);
      return {
        objectiveId,
        topic: bucket[0]?.topic || 'objective',
        attempts: bucket.length,
        accuracy: accuracyFor(bucket),
        recentTrend: trendForResults(bucket),
      };
    });

  const byItemType = [...new Set(visibleResults.map((result) => result.itemType || 'single'))].sort().map((itemType) => {
    const bucket = visibleResults.filter((result) => (result.itemType || 'single') === itemType);
    return { itemType, attempts: bucket.length, accuracy: accuracyFor(bucket) };
  });

  const rubricCriteria = [...new Set(constructedResponseAttempts.flatMap((attempt) => Object.keys(attempt.rubricScores || {})))].sort();
  const essayRubrics = (rubricCriteria.length ? rubricCriteria : ['identify', 'apply', 'justify']).map((criterion) => {
    const scores = visibleConstructedResponseAttempts
      .map((attempt) => {
        const possible = 2;
        const earned = attempt.rubricScores[criterion] ?? 0;
        return possible ? Math.round((earned / possible) * 100) : 0;
      });
    return {
      criterion,
      attempts: scores.length,
      averagePct: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    };
  });

  const constructedResponseWeaknesses = essayRubrics
    .map((row) => ({ ...row, impact: impactFromScore(row.averagePct, 0.35) }))
    .filter((row) => row.attempts > 0 && row.impact > 0)
    .sort((a, b) => b.impact - a.impact || a.averagePct - b.averagePct);
  const objectiveImpacts = artifactObjectiveImpacts(artifacts, skillLabAttempts).slice(0, 20);
  const skillLabs = [...new Set(visibleSkillLabAttempts.map((attempt) => attempt.labId))].sort().map((labId) => {
    const bucket = visibleSkillLabAttempts.filter((attempt) => attempt.labId === labId);
    const latest = [...bucket].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const impactedObjectives = new Set(bucket.flatMap((attempt) => attempt.objectiveIds)).size;
    const latestScore = latest?.score;
    return {
      labId,
      labType: latest?.labType,
      attempts: bucket.length,
      latestScore,
      impactedObjectives,
      impact: latestScore === undefined ? 0 : impactFromScore(latestScore, latest?.labType === 'calculator' ? 0.22 : 0.3),
    };
  });

  return {
    generatedAt: nowIso(),
    totals: {
      questionsAnswered: visibleResults.length,
      sessions: visibleSessions.length,
      studyTimeSeconds: visibleSessions.reduce((sum, session) => sum + (session.elapsedSeconds || 0), 0),
      mockAttempts: visibleMockAttempts.length,
      vignetteAttempts: visibleVignetteAttempts.length,
      constructedResponseAttempts: visibleConstructedResponseAttempts.length,
      skillLabAttempts: visibleSkillLabAttempts.length + visibleFormulaDrillAttempts.length,
      flashcardAttempts: visibleFlashcardAttempts.length,
      artifacts: visibleArtifacts.length,
    },
    byLevel,
    byObjective,
    byItemType,
    essayRubrics,
    constructedResponseWeaknesses,
    skillLabs,
    objectiveImpacts,
    byTopic,
    byDifficulty,
    byErrorCategory,
    confidenceCalibration,
    rollingTrend,
  };
}

export async function recordMockAttempt({
  domain = 'cfa',
  level = 'level1',
  title,
  mode = 'mock-section',
  score,
  total,
  elapsedSeconds,
  flaggedQuestionIds = [],
  answers,
}: Omit<MockAttempt, 'id' | 'createdAt' | 'pct' | 'topicBreakdown' | 'answers'> & {
  answers: Array<Partial<QuestionResultRow> & { selected?: number; correctIndex?: number }>;
}) {
  const timestamp = nowIso();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const normalizedAnswers = answers.map((answer) =>
    normalizeQuestionResult(
      {
        ...answer,
        domain,
        topic: answer.topic || 'mock',
        title,
        path: answer.path || '/cfa/mock',
      },
      timestamp,
    ),
  );
  const topicMap = new Map<string, { topic: string; score: number; total: number; pct: number }>();
  normalizedAnswers.forEach((answer) => {
    const row = topicMap.get(answer.topic) || { topic: answer.topic, score: 0, total: 0, pct: 0 };
    row.total += 1;
    row.score += answer.correct ? 1 : 0;
    row.pct = Math.round((row.score / row.total) * 100);
    topicMap.set(answer.topic, row);
  });

  await db.transaction(
    'rw',
    [
      db.mockAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.mockAttempts.add({
        domain,
        level,
        title,
        mode,
        score,
        total,
        pct,
        elapsedSeconds,
        flaggedQuestionIds,
        topicBreakdown: [...topicMap.values()],
        answers: normalizedAnswers,
        createdAt: timestamp,
      });
      for (const answer of normalizedAnswers) {
        await persistQuestionResult(answer);
      }
      await db.studySessions.add({
        domain,
        topic: 'mock',
        mode,
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: total,
        score: pct,
      });
    },
  );

  emitProgressChange();
}

export async function recordVignetteAttempt({
  domain = 'cfa',
  level,
  topic,
  vignetteId,
  title,
  score,
  total,
  elapsedSeconds,
  answers,
}: Omit<VignetteAttempt, 'id' | 'createdAt' | 'pct' | 'answers'> & {
  answers: Array<Partial<QuestionResultRow> & { selected?: number; correctIndex?: number }>;
}) {
  const timestamp = nowIso();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const normalizedAnswers = answers.map((answer) =>
    normalizeQuestionResult(
      {
        ...answer,
        domain,
        level,
        topic,
        title,
        itemType: 'vignette',
        path: answer.path || `/cfa/${level}/${topic.split(':').at(-1)}/vignette`,
      },
      timestamp,
    ),
  );

  await db.transaction(
    'rw',
    [
      db.vignetteAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.vignetteAttempts.add({
        domain,
        level,
        topic,
        vignetteId,
        title,
        score,
        total,
        pct,
        elapsedSeconds,
        answers: normalizedAnswers,
        createdAt: timestamp,
      });
      for (const answer of normalizedAnswers) {
        await persistQuestionResult(answer);
      }
      await db.studySessions.add({
        domain,
        topic,
        mode: 'vignette-review',
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: total,
        score: pct,
      });
    },
  );

  emitProgressChange();
}

export async function recordConstructedResponseAttempt({
  domain = 'cfa',
  level,
  topic,
  itemId,
  title,
  earnedPoints,
  maxPoints,
  rubricScores,
  response,
  elapsedSeconds,
  learningObjectives = [itemId],
  path = `/cfa/${level}/${topic.split(':').at(-1)}/constructed-response`,
}: Omit<ConstructedResponseAttempt, 'id' | 'createdAt' | 'pct'> & {
  learningObjectives?: string[];
  path?: string;
}) {
  const timestamp = nowIso();
  const pct = maxPoints > 0 ? Math.round((earnedPoints / maxPoints) * 100) : 0;
  const correct = pct >= 70;
  const results = learningObjectives.map((learningObjective, index) =>
    normalizeQuestionResult(
      {
        domain,
        level,
        topic,
        questionId: `${itemId}:${index + 1}`,
        learningObjective,
        objectiveTitle: title,
        correct,
        confidence: correct ? 'medium' : 'low',
        errorCategory: correct ? 'none' : 'concept',
        difficulty: 'advanced',
        elapsedSeconds,
        title,
        path,
        itemType: 'constructed-response',
      },
      timestamp,
    ),
  );

  await db.transaction(
    'rw',
    [
      db.constructedResponseAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.constructedResponseAttempts.add({
        domain,
        level,
        topic,
        itemId,
        title,
        earnedPoints,
        maxPoints,
        pct,
        rubricScores,
        response,
        elapsedSeconds,
        createdAt: timestamp,
      });
      for (const result of results) {
        await persistQuestionResult(result);
      }
      await db.studySessions.add({
        domain,
        topic,
        mode: 'mock-review',
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: 1,
        score: pct,
      });
    },
  );

  emitProgressChange();
}

export async function recordFormulaDrillAttempt({
  domain = 'cfa',
  level = 'level1',
  topic,
  formulaName,
  correct,
  confidence,
  elapsedSeconds,
}: Omit<FormulaDrillAttempt, 'id' | 'createdAt'>) {
  const timestamp = nowIso();
  const result = normalizeQuestionResult(
    {
      domain,
      level,
      topic,
      questionId: `formula:${formulaName}`,
      learningObjective: `formula:${formulaName}`,
      objectiveTitle: formulaName,
      correct,
      confidence,
      errorCategory: correct ? 'none' : 'formula',
      difficulty: 'foundation',
      elapsedSeconds,
      title: formulaName,
      path: '/flashcards',
      itemType: 'formula-drill',
      formula: formulaName,
    },
    timestamp,
  );

  await db.transaction(
    'rw',
    [
      db.formulaDrillAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.formulaDrillAttempts.add({ domain, level, topic, formulaName, correct, confidence, elapsedSeconds, createdAt: timestamp });
      await persistQuestionResult(result);
      await db.studySessions.add({
        domain,
        topic,
        mode: 'formula-drill',
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: 1,
        score: correct ? 100 : 0,
      });
    },
  );

  emitProgressChange();
}

export async function recordSkillLabAttempt({
  domain = 'cfa',
  level = 'level1',
  topic,
  labId,
  labType,
  objectiveIds,
  artifactId,
  score = 100,
  elapsedSeconds,
}: Omit<SkillLabAttempt, 'id' | 'createdAt'>) {
  const timestamp = nowIso();
  const correct = score >= 70;
  const results = objectiveIds.map((learningObjective, index) =>
    normalizeQuestionResult(
      {
        domain,
        level,
        topic,
        questionId: `${labId}:${index + 1}`,
        learningObjective,
        objectiveTitle: labId,
        correct,
        confidence: correct ? 'medium' : 'low',
        errorCategory: correct ? 'none' : 'calculation',
        difficulty: labType === 'calculator' ? 'foundation' : 'intermediate',
        elapsedSeconds,
        title: labId,
        path: labType === 'calculator' ? '/calculators' : `/${labType === 'quant-lab' ? 'quant' : 'excel'}`,
        itemType: labType,
      },
      timestamp,
    ),
  );

  await db.transaction(
    'rw',
    [
      db.skillLabAttempts,
      db.questionResults,
      db.reviewItems,
      db.masterySnapshots,
      db.reviewEvents,
      db.confidenceCalibration,
      db.studySessions,
    ],
    async () => {
      await db.skillLabAttempts.add({
        domain,
        level,
        topic,
        labId,
        labType,
        objectiveIds,
        artifactId,
        score,
        elapsedSeconds,
        createdAt: timestamp,
      });
      for (const result of results) {
        await persistQuestionResult(result);
      }
      await db.studySessions.add({
        domain,
        topic,
        mode: labType === 'calculator' ? 'calculator-drill' : labType,
        startedAt: new Date(new Date(timestamp).getTime() - elapsedSeconds * 1000).toISOString(),
        endedAt: timestamp,
        elapsedSeconds,
        questionsAnswered: objectiveIds.length || 1,
        score,
      });
    },
  );

  emitProgressChange();
}

export async function attachArtifactToNote(artifactId: string, noteId: string) {
  const artifact = await db.resultArtifacts.get(artifactId);
  if (!artifact) return null;
  const updated = { ...artifact, noteId };
  await db.resultArtifacts.put(updated);
  emitProgressChange();
  return updated;
}

export async function exportArtifactCsv(type?: ResultArtifact['type']) {
  const artifacts = await getResultArtifacts(type);
  const rows = [
    ['id', 'type', 'level', 'topic', 'title', 'summary', 'createdAt'],
    ...artifacts.map((artifact) => [
      artifact.id,
      artifact.type,
      artifact.level || '',
      artifact.topic || '',
      artifact.title,
      artifact.summary.replace(/\r?\n/g, ' '),
      artifact.createdAt,
    ]),
  ];
  return rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function exportMockSummary(attempt: MockAttempt | VignetteAttempt | ConstructedResponseAttempt) {
  return JSON.stringify(attempt, null, 2);
}

export async function getReadinessByObjective(options: Level3PathwayQuery = {}): Promise<ObjectiveReadiness[]> {
  const snapshots = await db.masterySnapshots.toArray();
  return snapshots
    .filter((snapshot) => level3TopicRowAllowed(snapshot, options.level3Pathway))
    .map((snapshot) => ({
      id: snapshot.id,
      domain: snapshot.domain,
      level: snapshot.topic.includes(':') ? snapshot.topic.split(':')[0] : 'level1',
      topic: snapshot.topic,
      learningObjective: snapshot.learningObjective,
      title: snapshot.title,
      readinessScore: snapshot.score,
      masteryScore: snapshot.score,
      attempts: snapshot.attempts,
      dueAt: snapshot.nextReviewAt,
      trend: snapshot.trend,
    }))
    .sort((a, b) => a.readinessScore - b.readinessScore);
}

function reasonForObjective(readinessScore: number, retentionForecastPct?: number): ReviewReason {
  if (retentionForecastPct !== undefined && retentionForecastPct < 72) return 'due-review';
  if (readinessScore < 55) return 'weak-objective';
  if (readinessScore < 75) return 'stale-topic';
  return 'unfinished-lesson';
}

function topWeaknessSignals(signals: ObjectiveReadinessV2['weaknessSignals'], limit = 5) {
  const sorted = [...signals].sort((a, b) => b.impact - a.impact);
  const top = sorted.slice(0, limit);
  const artifactSignal = sorted.find((signal) => signal.type === 'artifact');
  if (artifactSignal && !top.some((signal) => signal.type === 'artifact')) {
    top[Math.max(0, top.length - 1)] = artifactSignal;
  }
  return top.sort((a, b) => b.impact - a.impact);
}

export async function getReadinessByObjectiveV2(options: Level3PathwayQuery = {}): Promise<ObjectiveReadinessV2[]> {
  const [objectives, reviewItems, results, settings, constructedResponseAttempts, artifacts, skillLabAttempts] = await Promise.all([
    getReadinessByObjective(options),
    db.reviewItems.toArray(),
    db.questionResults.toArray(),
    getStudyPlanSettings(),
    db.constructedResponseAttempts.toArray(),
    db.resultArtifacts.toArray(),
    db.skillLabAttempts.toArray(),
  ]);
  const visibleResults = results.filter((result) => level3TopicRowAllowed(result, options.level3Pathway));
  const visibleReviews = reviewItems.filter((item) => level3TopicRowAllowed(item, options.level3Pathway));
  const visibleConstructedResponseAttempts = constructedResponseAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const visibleArtifacts = artifacts.filter((artifact) => level3TopicRowAllowed(artifact, options.level3Pathway));
  const visibleSkillLabAttempts = skillLabAttempts.filter((attempt) => level3TopicRowAllowed(attempt, options.level3Pathway));
  const artifactImpacts = artifactObjectiveImpacts(visibleArtifacts, visibleSkillLabAttempts);

  return objectives
    .map((objective) => {
      const review = visibleReviews.find((item) => item.id === objective.id);
      const objectiveResults = visibleResults.filter(
        (result) =>
          result.domain === objective.domain &&
          result.topic === objective.topic &&
          result.learningObjective === objective.learningObjective,
      );
      const itemTypeWeight = Math.max(1, ...objectiveResults.map((result) => itemTypeWeightFor(result.itemType)));
      const weightedAccuracy = weightedAccuracyFor(objectiveResults);
      const topicWeight = topicWeightFor(settings.topicWeights, objective.topic);
      const retentionForecastPct = review ? Math.round(predictRetention(review, new Date()) * 100) : undefined;
      const rubricSignals = lowestRubricSignals(visibleConstructedResponseAttempts, objective.topic).map((signal) => ({
        type: 'rubric' as const,
        label: `${signal.criterion} rubric ${signal.averagePct}%`,
        impact: signal.impact,
      }));
      const objectiveArtifactSignals = artifactImpacts
        .filter((impact) => impact.objectiveId === objective.learningObjective || impact.objectiveId === objective.id)
        .slice(0, 3)
        .map((impact) => ({
          type: 'artifact' as const,
          label: `${itemTypeLabel(impact.sourceType)} impact ${impact.averageScore}%`,
          impact: impact.impact,
        }));
      const retentionImpact = retentionForecastPct === undefined ? 0 : impactFromScore(retentionForecastPct, 0.35);
      const itemTypeImpact = impactFromScore(weightedAccuracy, itemTypeWeight - 1);
      const topicWeightImpact = Math.round(topicWeight * 0.35);
      const signals = [
        itemTypeImpact
          ? {
              type: 'item-type' as const,
              label: `${itemTypeLabel(objectiveResults.find((result) => itemTypeWeightFor(result.itemType) === itemTypeWeight)?.itemType)} evidence ${weightedAccuracy}%`,
              impact: itemTypeImpact,
            }
          : null,
        retentionImpact
          ? {
              type: 'retention' as const,
              label: `retention forecast ${retentionForecastPct}%`,
              impact: retentionImpact,
            }
          : null,
        topicWeightImpact
          ? {
              type: 'topic-weight' as const,
              label: `topic weight ${topicWeight}%`,
              impact: topicWeightImpact,
            }
          : null,
        ...rubricSignals,
        ...objectiveArtifactSignals,
      ].filter(Boolean) as ObjectiveReadinessV2['weaknessSignals'];
      const signalPenalty = Math.min(24, signals.reduce((sum, signal) => sum + signal.impact, 0) * 0.18);
      const weightedScore = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            objective.readinessScore -
              Math.max(0, 78 - (retentionForecastPct ?? 78)) * 0.25 -
              topicWeight * 0.05 -
              Math.max(0, objective.readinessScore - weightedAccuracy) * (itemTypeWeight - 1) * 0.45 -
              signalPenalty,
          ),
        ),
      );
      const primaryReason = reasonForObjective(weightedScore, retentionForecastPct);
      return {
        ...objective,
        readinessVersion: 2 as const,
        readinessScore: weightedScore,
        itemTypeAdjustedScore: weightedAccuracy,
        itemTypeWeight,
        topicWeight,
        retentionForecastPct,
        evidenceCount: objectiveResults.length,
        primaryReason,
        reasonDetails: explainReviewReason(primaryReason, {
          score: weightedScore,
          retentionPct: retentionForecastPct,
          topicWeight,
          itemType: objectiveResults.find((result) => itemTypeWeightFor(result.itemType) === itemTypeWeight)?.itemType,
        }),
        weaknessSignals: topWeaknessSignals(signals),
      };
    })
    .sort((a, b) => a.readinessScore - b.readinessScore);
}

export async function getReadinessByLevel() {
  const readiness = await getReadinessByTopic();
  const levels = [...new Set(readiness.map((item) => (item.topic.includes(':') ? item.topic.split(':')[0] : 'level1')))];
  return levels.map((level) => {
    const bucket = readiness.filter((item) => (item.topic.includes(':') ? item.topic.split(':')[0] : 'level1') === level);
    return {
      level,
      topics: bucket.length,
      readinessScore: bucket.length ? Math.round(bucket.reduce((sum, item) => sum + item.readinessScore, 0) / bucket.length) : 0,
      dueCount: bucket.reduce((sum, item) => sum + item.dueCount, 0),
    };
  });
}

export function getExamPlan() {
  return getStudyPlan();
}

export async function getNotes() {
  return db.notes.orderBy('updatedAt').reverse().toArray();
}

export async function getBookmarks() {
  return db.bookmarks.orderBy('createdAt').reverse().toArray();
}

export async function rebuildLearningIndexes({ emit = true }: { emit?: boolean } = {}) {
  const results = (await db.questionResults.toArray())
    .filter((row) => row.domain && row.topic && row.questionId && row.learningObjective && isValidIsoDate(row.createdAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groupedResults = new Map<string, QuestionResultRow[]>();
  const latestReviewById = new Map<string, ReviewItem>();

  await db.transaction('rw', [db.reviewItems, db.masterySnapshots, db.reviewEvents, db.confidenceCalibration], async () => {
    await Promise.all([
      db.reviewItems.clear(),
      db.masterySnapshots.clear(),
      db.reviewEvents.clear(),
      db.confidenceCalibration.clear(),
    ]);

    for (const result of results) {
      const id = objectiveId(result.domain, result.topic, result.learningObjective);
      const previous = latestReviewById.get(id);
      const review = buildReviewItem(result, previous);
      latestReviewById.set(id, review);
      if (!groupedResults.has(id)) groupedResults.set(id, []);
      groupedResults.get(id)?.push(result);

      await db.reviewItems.put(review);
      await db.reviewEvents.add({
        domain: result.domain,
        topic: result.topic,
        learningObjective: result.learningObjective,
        eventType: previous ? 'rescheduled' : 'scheduled',
        reviewItemId: review.id,
        dueAt: review.dueAt,
        createdAt: result.createdAt,
      });
      await db.confidenceCalibration.add({
        domain: result.domain,
        topic: result.topic,
        learningObjective: result.learningObjective,
        questionId: result.questionId,
        confidence: result.confidence,
        correct: result.correct,
        createdAt: result.createdAt,
      });
    }

    for (const [id, objectiveResults] of groupedResults.entries()) {
      const latest = objectiveResults.at(-1);
      const review = latestReviewById.get(id);
      if (!latest || !review) continue;
      const score = masteryScoreForResults(objectiveResults);
      const confidenceScore = Math.round(
        objectiveResults.reduce((sum, row) => sum + CONFIDENCE_SCORE[row.confidence], 0) /
          Math.max(1, objectiveResults.length),
      );
      await db.masterySnapshots.put({
        id,
        domain: latest.domain,
        topic: latest.topic,
        learningObjective: latest.learningObjective,
        title: latest.objectiveTitle || latest.title || latest.learningObjective,
        score,
        attempts: objectiveResults.length,
        correct: objectiveResults.filter((row) => row.correct).length,
        confidenceScore,
        lastAttemptAt: latest.createdAt,
        nextReviewAt: review.dueAt,
        trend: 'flat',
      });
    }
  });

  if (emit) emitProgressChange();
  return {
    questionResults: results.length,
    reviewItems: latestReviewById.size,
    masterySnapshots: groupedResults.size,
  };
}

async function storageEstimate() {
  if (typeof navigator === 'undefined') return undefined;
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => undefined);
  if (!estimate && persisted === undefined) return undefined;
  return {
    usage: estimate?.usage,
    quota: estimate?.quota,
    persisted,
  };
}

function buildVaultHealthSnapshot(exported: VaultExport, validationErrors: string[]): VaultHealthSnapshot {
  const totalRows = STORE_NAMES.reduce((sum, storeName) => sum + exported.stores[storeName].length, 0);
  const malformedQuestionRows = exported.stores.questionResults.filter(
    (row) => !row.domain || !row.topic || !row.questionId || !row.learningObjective || !isValidIsoDate(row.createdAt),
  ).length;
  const malformedReviewRows = exported.stores.reviewItems.filter(
    (row) => !row.id || !row.dueAt || Number.isNaN(new Date(row.dueAt).getTime()),
  ).length;
  const objectiveKeys = new Set(
    exported.stores.questionResults.map((row) => objectiveId(row.domain, row.topic, row.learningObjective)),
  );
  const orphanedReviews = exported.stores.reviewItems.filter(
    (row) => row.learningObjective && row.topic && !objectiveKeys.has(objectiveId(row.domain, row.topic, row.learningObjective)),
  ).length;
  const indexedObjectives = new Set(exported.stores.masterySnapshots.map((row) => row.id));
  const staleIndexes = [...objectiveKeys].filter((key) => !indexedObjectives.has(key)).length;
  const checksumIssues = validationErrors.filter((error) => /checksum/i.test(error)).length;
  const repairActions = [
    malformedQuestionRows || malformedReviewRows ? `Remove or normalize ${malformedQuestionRows + malformedReviewRows} malformed learning row(s).` : '',
    orphanedReviews ? `Rebuild ${orphanedReviews} orphaned review row(s) from canonical attempts.` : '',
    staleIndexes ? `Rebuild ${staleIndexes} stale mastery/review index row(s).` : '',
    checksumIssues ? 'Reject the payload or regenerate it from a trusted local vault export.' : '',
  ].filter(Boolean);

  return {
    id: `vault-health:${exported.exportId}`,
    generatedAt: nowIso(),
    status: checksumIssues || malformedQuestionRows || malformedReviewRows ? 'repair-needed' : orphanedReviews || staleIndexes ? 'warning' : 'ok',
    totalRows,
    malformedRows: malformedQuestionRows + malformedReviewRows,
    orphanedReviews,
    staleIndexes,
    checksumIssues,
    repairActions,
  };
}

export async function getVaultHealthReport(): Promise<VaultHealthReport> {
  const exported = await exportVaultData();
  const validation = validateVaultData(exported);
  const snapshot = buildVaultHealthSnapshot(exported, validation.errors);
  const [rollbackSnapshots, importJobs, sourceBundleManifests, calculatorScenarios, releaseRunHistory] = await Promise.all([
    db.rollbackSnapshots.orderBy('createdAt').reverse().limit(10).toArray(),
    db.importJobs.orderBy('startedAt').reverse().limit(10).toArray(),
    db.sourceBundleManifests.orderBy('createdAt').reverse().limit(10).toArray(),
    db.calculatorScenarios.orderBy('updatedAt').reverse().limit(10).toArray(),
    db.releaseRunHistory.orderBy('generatedAt').reverse().limit(10).toArray(),
  ]);
  const report: VaultHealthReport = {
    ...snapshot,
    schemaVersion: VAULT_SCHEMA_VERSION,
    schemaHash: VAULT_SCHEMA_HASH,
    contentVersion: VAULT_CONTENT_VERSION,
    importHistory: await getVaultImportHistory(),
    rollbackSnapshots,
    importJobs,
    sourceBundleManifests,
    calculatorScenarios,
    releaseRunHistory,
    storageEstimate: await storageEstimate(),
  };
  await db.vaultHealthSnapshots.put(snapshot);
  return report;
}

export async function previewVaultRepair(): Promise<VaultHealthReport> {
  return getVaultHealthReport();
}

export async function repairVaultData() {
  await createRollbackSnapshot('repair');
  const exported = await exportVaultData();
  const seenNotes = new Set<string>();
  const seenBookmarks = new Set<string>();
  const repaired: VaultExport = {
    ...exported,
    stores: {
      ...exported.stores,
      questionResults: exported.stores.questionResults.filter(
        (row) => row.domain && row.topic && row.questionId && row.learningObjective,
      ),
      reviewItems: exported.stores.reviewItems.filter((row) => row.id && row.dueAt && !Number.isNaN(new Date(row.dueAt).getTime())),
      notes: exported.stores.notes.filter((row) => {
        if (!row.id || seenNotes.has(row.id)) return false;
        seenNotes.add(row.id);
        return true;
      }),
      bookmarks: exported.stores.bookmarks.filter((row) => {
        if (!row.id || seenBookmarks.has(row.id)) return false;
        seenBookmarks.add(row.id);
        return true;
      }),
    },
  };
  await importVaultData(repaired, 'replace');
  await rebuildLearningIndexes({ emit: false });
  await getVaultHealthReport();
  return previewVaultImport(repaired);
}

export async function resetVaultData(scope: 'attempts' | 'progress' | 'full' = 'full') {
  const rollbackSnapshot = await createRollbackSnapshot('reset');
  if (scope === 'attempts') {
    await Promise.all([
      db.quizAttempts.clear(),
      db.questionResults.clear(),
      db.reviewItems.clear(),
      db.masterySnapshots.clear(),
      db.mockAttempts.clear(),
      db.vignetteAttempts.clear(),
      db.constructedResponseAttempts.clear(),
      db.formulaDrillAttempts.clear(),
      db.skillLabAttempts.clear(),
      db.reviewEvents.clear(),
      db.confidenceCalibration.clear(),
      db.flashcardAttempts.clear(),
      db.resultArtifacts.clear(),
      db.mockSectionState.clear(),
      db.studySessions.clear(),
      db.learningEvents.clear(),
    ]);
  } else if (scope === 'progress') {
    await Promise.all([
      db.lessonProgress.clear(),
      db.quizAttempts.clear(),
      db.questionResults.clear(),
      db.reviewItems.clear(),
      db.masterySnapshots.clear(),
      db.mockAttempts.clear(),
      db.vignetteAttempts.clear(),
      db.constructedResponseAttempts.clear(),
      db.formulaDrillAttempts.clear(),
      db.skillLabAttempts.clear(),
      db.reviewEvents.clear(),
      db.confidenceCalibration.clear(),
      db.flashcardAttempts.clear(),
      db.resultArtifacts.clear(),
      db.mockSectionState.clear(),
      db.studySessions.clear(),
      db.learningEvents.clear(),
    ]);
  } else {
    await Promise.all([...STORE_NAMES, ...SOURCE_STORE_NAMES].map((storeName) => db[storeName].clear()));
    await db.rollbackSnapshots.put(rollbackSnapshot);
  }

  emitProgressChange();
}
