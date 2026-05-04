import Dexie, { liveQuery, type Table } from 'dexie';
import {
  isDue,
  masteryScoreForResults,
  nextRecommendation,
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
  FormulaDrillAttempt,
  LessonProgress,
  MasterySnapshot,
  MockSectionState,
  MockAttempt,
  ConstructedResponseAttempt,
  ObjectiveReadiness,
  QuestionResult,
  QuizAttempt,
  ResultArtifact,
  ReviewEvent,
  ReviewQueueItem,
  ReviewItem,
  SkillLabAttempt,
  StudyPlan,
  StudyPlanSettings,
  StudySession,
  TopicReadiness,
  VignetteAttempt,
  VaultBookmark,
  VaultNote,
} from './learningTypes';

export const PROGRESS_EVENT = 'quantvault:progress';
export const VAULT_SCHEMA_VERSION = 5;

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
  notes: VaultNote[];
  bookmarks: VaultBookmark[];
  settings: SettingRow[];
};

export type VaultExport = {
  app: 'QuantVault';
  schemaVersion: number;
  exportedAt: string;
  stores: VaultDataStores;
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
  notes: Table<VaultNote, string>;
  bookmarks: Table<VaultBookmark, string>;
  settings: Table<SettingRow, string>;
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

db.version(VAULT_SCHEMA_VERSION).stores({
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

function nowIso() {
  return new Date().toISOString();
}

function emitProgressChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PROGRESS_EVENT));
  }
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

export async function getDueReviews(date = new Date()) {
  const reviewItems = await db.reviewItems.toArray();
  return rankReviewItems(reviewItems, date).filter((item) => isDue(item, date));
}

export async function getMasterySummary() {
  const snapshots = await db.masterySnapshots.toArray();
  const ranked = [...snapshots].sort((a, b) => a.score - b.score || b.lastAttemptAt.localeCompare(a.lastAttemptAt));
  return {
    snapshots,
    weakObjectives: ranked.filter((snapshot) => snapshot.score < 72).slice(0, 6),
    averageScore: snapshots.length
      ? Math.round(snapshots.reduce((sum, snapshot) => sum + snapshot.score, 0) / snapshots.length)
      : null,
  };
}

export async function getNextRecommendation() {
  const [dueReviews, mastery, lessonProgress] = await Promise.all([
    getDueReviews(),
    getMasterySummary(),
    db.lessonProgress.orderBy('lastVisitedAt').reverse().first(),
  ]);

  return nextRecommendation({
    dueReviews,
    weakObjectives: mastery.weakObjectives.map((objective) => ({
      title: objective.title,
      path: defaultPathFor(objective.domain, objective.topic, 'weak-areas'),
      score: objective.score,
    })),
    continuePath: lessonProgress?.path || null,
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
}: Pick<VaultNote, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName'>) {
  return [type, domain || 'vault', moduleId || questionId || formulaName || 'general'].join(':');
}

export async function getNote(target: Pick<VaultNote, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName'>) {
  return db.notes.get(noteIdFor(target));
}

export async function saveNote({
  type,
  domain,
  moduleId,
  questionId,
  formulaName,
  title,
  body,
  path,
}: Omit<VaultNote, 'id' | 'createdAt' | 'updatedAt'>) {
  const id = noteIdFor({ type, domain, moduleId, questionId, formulaName });
  const existing = await db.notes.get(id);
  const timestamp = nowIso();
  const note: VaultNote = {
    id,
    type,
    domain,
    moduleId,
    questionId,
    formulaName,
    title,
    body,
    path,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };

  await db.notes.put(note);
  emitProgressChange();
  return note;
}

export async function deleteNote(target: Pick<VaultNote, 'type' | 'domain' | 'moduleId' | 'questionId' | 'formulaName'>) {
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

export async function exportVaultData(): Promise<VaultExport> {
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
    db.notes.toArray(),
    db.bookmarks.toArray(),
    db.settings.toArray(),
  ]);

  return {
    app: 'QuantVault',
    schemaVersion: VAULT_SCHEMA_VERSION,
    exportedAt: nowIso(),
    stores: {
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
      notes,
      bookmarks,
      settings,
    },
  };
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
    notes: [],
    bookmarks: [],
    settings: [],
  };
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

  return {
    app: payload.app === 'QuantVault' ? 'QuantVault' : 'QuantVault',
    schemaVersion: VAULT_SCHEMA_VERSION,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : nowIso(),
    stores: migratedStores,
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
  STORE_NAMES.forEach((storeName) => {
    if (!Array.isArray(migrated.stores[storeName])) errors.push(`${storeName} must be an array.`);
  });

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

export function previewVaultImport(payload: unknown) {
  const validation = validateVaultData(payload);
  if (!validation.valid) {
    return { valid: false, errors: validation.errors, schemaVersion: null, counts: emptyVaultStores() };
  }

  const migrated = migrateVaultData(payload);
  return {
    valid: true,
    errors: [],
    schemaVersion: migrated.schemaVersion,
    counts: STORE_NAMES.reduce(
      (counts, storeName) => ({
        ...counts,
        [storeName]: migrated.stores[storeName].length,
      }),
      {} as Record<(typeof STORE_NAMES)[number], number>,
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

export async function importVaultData(payload: unknown, mode: 'merge' | 'replace' = 'merge') {
  const exportPayload = migrateVaultData(payload);
  const validation = validateVaultData(payload);
  if (!validation.valid) {
    throw new Error(validation.errors.join(' '));
  }
  const storesToWrite = mode === 'merge' ? remapMergeIds(exportPayload.stores) : exportPayload.stores;

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
      db.notes,
      db.bookmarks,
      db.settings,
    ],
    async () => {
      if (mode === 'replace') {
        await Promise.all(STORE_NAMES.map((storeName) => db[storeName].clear()));
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
        db.notes.bulkPut(storesToWrite.notes),
        db.bookmarks.bulkPut(storesToWrite.bookmarks),
        db.settings.bulkPut(storesToWrite.settings),
      ]);
    },
  );

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

export async function getReadinessByTopic(date = new Date()): Promise<TopicReadiness[]> {
  const [snapshots, reviewItems, results] = await Promise.all([
    db.masterySnapshots.toArray(),
    db.reviewItems.toArray(),
    db.questionResults.toArray(),
  ]);
  const grouped = new Map<string, MasterySnapshot[]>();
  snapshots.forEach((snapshot) => {
    const key = `${snapshot.domain}:${snapshot.topic}`;
    grouped.set(key, [...(grouped.get(key) || []), snapshot]);
  });

  return [...grouped.entries()]
    .map(([key, topicSnapshots]) => {
      const [domainPart, ...topicParts] = key.split(':');
      const domain = domainPart as DomainId;
      const topic = topicParts.join(':');
      const topicResults = results.filter((result) => result.domain === domain && result.topic === topic);
      const topicReviews = reviewItems.filter((item) => item.domain === domain && item.topic === topic);
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

export async function forecastReviewLoad(days = 14, date = new Date()) {
  const reviewItems = await db.reviewItems.toArray();
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(date);
    day.setDate(date.getDate() + index);
    const key = day.toISOString().slice(0, 10);
    return {
      date: key,
      count: reviewItems.filter((item) => item.dueAt.slice(0, 10) === key).length,
    };
  });
}

const DEFAULT_STUDY_PLAN_SETTINGS: StudyPlanSettings = {
  id: 'local-study-plan',
  targetLevel: 'level1',
  dailyTargetMinutes: 45,
  examDate: null,
  restDays: [],
  mockCadenceDays: 14,
  topicWeights: {},
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

export async function getStudyPlan({
  examDate,
  dailyTargetMinutes,
  targetLevel,
}: {
  examDate?: string | null;
  dailyTargetMinutes?: number;
  targetLevel?: string;
} = {}): Promise<StudyPlan> {
  const [settings, dueReviews, forecast, readiness, recommendation] = await Promise.all([
    getStudyPlanSettings(),
    getDueReviews(),
    forecastReviewLoad(14),
    getReadinessByTopic(),
    getNextRecommendation(),
  ]);
  const effectiveExamDate = examDate !== undefined ? examDate : settings.examDate;
  const effectiveDailyTarget = dailyTargetMinutes ?? settings.dailyTargetMinutes;
  const effectiveTargetLevel = targetLevel || settings.targetLevel || 'level1';
  const daysToExam = effectiveExamDate ? Math.max(0, Math.ceil(daysBetween(new Date(), new Date(effectiveExamDate)))) : null;
  const weakest = readiness[0];

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
      recommendation,
      ...(weakest
        ? [
            {
              label: 'Readiness',
              title: weakest.title,
              path: defaultPathFor(weakest.domain, weakest.topic, 'weak-areas'),
              reason: `Topic readiness is ${weakest.readinessScore}%.`,
            },
          ]
        : []),
    ],
    updatedAt: nowIso(),
  };
}

export async function getReviewInbox(): Promise<ReviewQueueItem[]> {
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
    getDueReviews(),
    getMasterySummary(),
    db.questionResults.orderBy('createdAt').reverse().toArray(),
    db.bookmarks.toArray(),
    db.lessonProgress.toArray(),
    getReadinessByTopic(),
    db.mockAttempts.orderBy('createdAt').reverse().toArray(),
    db.vignetteAttempts.orderBy('createdAt').reverse().toArray(),
    db.constructedResponseAttempts.orderBy('createdAt').reverse().toArray(),
    db.formulaDrillAttempts.orderBy('createdAt').reverse().toArray(),
    db.skillLabAttempts.orderBy('createdAt').reverse().toArray(),
    db.resultArtifacts.orderBy('createdAt').reverse().toArray(),
  ]);
  const latestWrongByQuestion = new Map<string, QuestionResultRow>();
  results.forEach((result) => {
    const key = `${result.domain}:${result.topic}:${result.questionId}`;
    if (!result.correct && !latestWrongByQuestion.has(key)) latestWrongByQuestion.set(key, result);
  });

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
    })),
    ...mastery.weakObjectives.map((item) => ({
      id: `weak:${item.id}`,
      type: 'weak-objective' as const,
      title: item.title,
      subtitle: `${item.score}% mastery across ${item.attempts} attempts`,
      path: defaultPathFor(item.domain, item.topic, 'weak-areas'),
      priority: 85 - item.score,
      topic: item.topic,
    })),
    ...[...latestWrongByQuestion.values()].slice(0, 12).map((item) => ({
      id: `miss:${item.domain}:${item.topic}:${item.questionId}`,
      type: 'missed-question' as const,
      title: item.title || item.questionId,
      subtitle: `Missed question - ${item.errorCategory}`,
      path: item.path || defaultPathFor(item.domain, item.topic, 'review-due'),
      priority: 72,
      topic: item.topic,
    })),
    ...bookmarks.map((item) => ({
      id: `bookmark:${item.id}`,
      type: 'bookmark' as const,
      title: item.title,
      subtitle: `${item.type} bookmark`,
      path: item.path,
      priority: 45,
      topic: item.moduleId,
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
      })),
    ...mockAttempts
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
      })),
    ...vignetteAttempts
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
      })),
    ...constructedResponseAttempts
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
      })),
    ...formulaDrillAttempts
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
      })),
    ...skillLabAttempts
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
      })),
    ...artifacts.slice(0, 6).map((artifact) => ({
      id: `artifact:${artifact.id}`,
      type: 'bookmark' as const,
      title: artifact.title,
      subtitle: `${artifact.type} artifact saved to vault`,
      path: artifact.path || '/vault',
      priority: 38,
      topic: artifact.topic,
    })),
    ...lessonProgress
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

export async function getConfidenceCalibration(): Promise<ConfidenceCalibrationSummary[]> {
  const rows = await db.confidenceCalibration.toArray();
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

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
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
    confidenceCalibration,
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
    getConfidenceCalibration(),
  ]);

  const topics = [...new Set(results.map((result) => result.topic))].sort();
  const byTopic = topics.map((topic) => {
    const topicResults = results.filter((result) => result.topic === topic);
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
    const bucket = results.filter((result) => result.difficulty === difficulty);
    return { difficulty, attempts: bucket.length, accuracy: accuracyFor(bucket) };
  });

  const byErrorCategory = ERROR_CATEGORIES.map((errorCategory) => ({
    errorCategory,
    attempts: results.filter((result) => result.errorCategory === errorCategory).length,
  })).filter((row) => row.attempts > 0 || row.errorCategory === 'none');

  const rollingTrend = [...new Set(results.map((result) => result.createdAt.slice(0, 10)))]
    .sort()
    .slice(-14)
    .map((date) => {
      const bucket = results.filter((result) => result.createdAt.slice(0, 10) === date);
      return { date, attempts: bucket.length, accuracy: accuracyFor(bucket) };
    });

  const byLevel = [...new Set(results.map((result) => result.level || (result.topic.includes(':') ? result.topic.split(':')[0] : 'level1')))]
    .sort()
    .map((level) => {
      const bucket = results.filter((result) => (result.level || (result.topic.includes(':') ? result.topic.split(':')[0] : 'level1')) === level);
      return { level, attempts: bucket.length, accuracy: accuracyFor(bucket) };
    });

  const byObjective = [...new Set(results.map((result) => result.learningObjective))]
    .sort()
    .slice(0, 30)
    .map((objectiveId) => {
      const bucket = results.filter((result) => result.learningObjective === objectiveId);
      return {
        objectiveId,
        topic: bucket[0]?.topic || 'objective',
        attempts: bucket.length,
        accuracy: accuracyFor(bucket),
        recentTrend: trendForResults(bucket),
      };
    });

  const byItemType = [...new Set(results.map((result) => result.itemType || 'single'))].sort().map((itemType) => {
    const bucket = results.filter((result) => (result.itemType || 'single') === itemType);
    return { itemType, attempts: bucket.length, accuracy: accuracyFor(bucket) };
  });

  const essayRubrics = ['identify', 'apply', 'justify'].map((criterion) => {
    const scores = constructedResponseAttempts
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

  const skillLabs = [...new Set(skillLabAttempts.map((attempt) => attempt.labId))].sort().map((labId) => {
    const bucket = skillLabAttempts.filter((attempt) => attempt.labId === labId);
    return { labId, attempts: bucket.length, latestScore: bucket.at(-1)?.score };
  });

  return {
    generatedAt: nowIso(),
    totals: {
      questionsAnswered: results.length,
      sessions: sessions.length,
      studyTimeSeconds: sessions.reduce((sum, session) => sum + (session.elapsedSeconds || 0), 0),
      mockAttempts: mockAttempts.length,
      vignetteAttempts: vignetteAttempts.length,
      constructedResponseAttempts: constructedResponseAttempts.length,
      skillLabAttempts: skillLabAttempts.length + formulaDrillAttempts.length,
      flashcardAttempts: flashcardAttempts.length,
      artifacts: artifacts.length,
    },
    byLevel,
    byObjective,
    byItemType,
    essayRubrics,
    skillLabs,
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

export async function getReadinessByObjective(): Promise<ObjectiveReadiness[]> {
  const snapshots = await db.masterySnapshots.toArray();
  return snapshots
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

export async function repairVaultData() {
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
  return previewVaultImport(repaired);
}

export async function resetVaultData(scope: 'attempts' | 'progress' | 'full' = 'full') {
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
    ]);
  } else if (scope === 'progress') {
    await Promise.all([db.lessonProgress.clear(), db.quizAttempts.clear(), db.vignetteAttempts.clear(), db.studySessions.clear()]);
  } else {
    await Promise.all(STORE_NAMES.map((storeName) => db[storeName].clear()));
  }

  emitProgressChange();
}
