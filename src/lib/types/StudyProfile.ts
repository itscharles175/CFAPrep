/**
 * DATA-6 — the unified, cross-domain shared study profile.
 *
 * One reconciled profile that both the host (CFA/Quant/Excel) and the LSAT
 * backend agree on. It folds the LSAT `StudyPlan` (target_score / exam_date /
 * daily_minutes) and the host `StudyPlanSettings` (targetLevel /
 * dailyTargetMinutes / examDate, plus restDays / mockCadenceDays / topicWeights)
 * into ONE shape. The backend arbiter (`GET/PUT /api/study/profile`) is the
 * single source of truth; the host mirrors it into Dexie via the degrading-fetch
 * bridge (`src/lib/studyProfileBridge.ts`).
 *
 * Conflict policy: last-write-wins by `updatedAt`. A writer stamps a fresh
 * `updatedAt`; the most recent write across either side wins per shared scalar.
 *
 * This intentionally lives in its OWN module (not `learningTypes.ts`) so the
 * cross-domain contract type is decoupled from the host's Dexie store types —
 * mirrors how `dataDictionary.ts` owns the canonical cross-domain shapes.
 */

/** Which side authored the most recent write (informational; the timestamp
 * decides arbitration). */
export type StudyProfileWriter = 'lsat' | 'host' | 'merge';

export type StudyDomain = 'cfa' | 'lsat' | 'quant' | 'excel';

/** A domain-specific outcome. Optional fields keep older profile payloads valid. */
export interface StudyDomainGoal {
  enabled: boolean;
  goal: string | null;
  targetDate: string | null;
}

export type StudyDomainGoals = Partial<Record<StudyDomain, StudyDomainGoal>>;
/** Daily minutes reserved for each enabled domain. */
export type StudyTimeAllocation = Partial<Record<StudyDomain, number>>;

/**
 * The reconciled shared study profile, mirroring the backend's
 * `SharedStudyProfileOut` (`services/lsat-backend/app/routers/study_routes.py`).
 *
 * Field names are camelCase on the host side; the bridge maps to/from the
 * backend's snake_case wire shape. The three shared scalars
 * (`targetScore`/`examDate`/`dailyMinutes`) are reconciled last-write-wins; the
 * host-owned fields (`targetLevel`/`restDays`/`mockCadenceDays`/`topicWeights`)
 * are carried verbatim so a host write round-trips losslessly.
 */
export interface SharedStudyProfile {
  /** True when an active LSAT `StudyPlan` exists (parity with `/study/plan`). */
  hasPlan: boolean;
  /** Reconciled LSAT target scaled score (120-180). */
  targetScore: number;
  /** ISO date "YYYY-MM-DD", or null when unset. */
  examDate: string | null;
  /** Reconciled daily study budget in minutes. */
  dailyMinutes: number;
  /** Host-owned target level (e.g. "level1" | "level2" | "level3"). */
  targetLevel: string | null;
  /** Host-owned weekly rest days (0=Sun..6=Sat). */
  restDays: number[];
  /** Host-owned mock-exam cadence in days. */
  mockCadenceDays: number | null;
  /** Host-owned per-topic planning weights. */
  topicWeights: Record<string, number>;
  /** Per-domain outcomes used by the cross-domain daily planner. */
  domainGoals: StudyDomainGoals;
  /** Daily minutes reserved for each domain; missing domains receive no reservation. */
  timeAllocation: StudyTimeAllocation;
  /** Who wrote last (informational). */
  lastWriter: StudyProfileWriter;
  /** ISO 8601 timestamp the arbiter ordered by, or null when no write yet. */
  updatedAt: string | null;
}

/**
 * A partial write to the shared profile. Every field optional so either side can
 * write only what it owns (unsent fields keep their current reconciled value).
 * Mirrors the backend `StudyProfileBody`.
 */
export interface StudyProfilePatch {
  targetScore?: number;
  examDate?: string | null;
  dailyMinutes?: number;
  targetLevel?: string | null;
  restDays?: number[];
  mockCadenceDays?: number | null;
  topicWeights?: Record<string, number>;
  domainGoals?: StudyDomainGoals;
  timeAllocation?: StudyTimeAllocation;
  lastWriter?: StudyProfileWriter;
}

/** The backend wire shape (snake_case) for `GET/PUT /api/study/profile`. The
 * bridge maps between this and {@link SharedStudyProfile}. Read permissively. */
export interface RawSharedStudyProfile {
  has_plan?: boolean;
  target_score?: number;
  exam_date?: string | null;
  daily_minutes?: number;
  target_level?: string | null;
  rest_days?: number[];
  mock_cadence_days?: number | null;
  topic_weights?: Record<string, number>;
  domain_goals?: Record<string, unknown>;
  time_allocation?: Record<string, unknown>;
  last_writer?: string;
  updated_at?: string | null;
}

/** A sensible, fully-populated default used when the backend is unreachable or
 * has never been written — keeps every consumer total (never undefined). */
export const DEFAULT_SHARED_STUDY_PROFILE: SharedStudyProfile = {
  hasPlan: false,
  targetScore: 165,
  examDate: null,
  dailyMinutes: 60,
  targetLevel: null,
  restDays: [],
  mockCadenceDays: null,
  topicWeights: {},
  domainGoals: {},
  timeAllocation: {},
  lastWriter: 'merge',
  updatedAt: null,
};

const WRITERS: readonly StudyProfileWriter[] = ['lsat', 'host', 'merge'];

function coerceWriter(value: unknown): StudyProfileWriter {
  return WRITERS.includes(value as StudyProfileWriter) ? (value as StudyProfileWriter) : 'merge';
}

const DOMAINS: readonly StudyDomain[] = ['cfa', 'lsat', 'quant', 'excel'];

function coerceDomainGoals(value: unknown): StudyDomainGoals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const goals: StudyDomainGoals = {};
  for (const domain of DOMAINS) {
    const raw = source[domain];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const goal = raw as Record<string, unknown>;
    goals[domain] = {
      enabled: typeof goal.enabled === 'boolean' ? goal.enabled : true,
      goal: typeof goal.goal === 'string' ? goal.goal : null,
      targetDate: typeof goal.targetDate === 'string'
        ? goal.targetDate
        : typeof goal.target_date === 'string' ? goal.target_date : null,
    };
  }
  return goals;
}

function coerceTimeAllocation(value: unknown): StudyTimeAllocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const allocation: StudyTimeAllocation = {};
  for (const domain of DOMAINS) {
    const minutes = source[domain];
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
      allocation[domain] = Math.round(minutes);
    }
  }
  return allocation;
}

/**
 * Project the backend snake_case body onto the host {@link SharedStudyProfile}.
 * Read defensively: a missing/garbled field falls back to the default so a shape
 * drift degrades a field rather than throwing.
 */
export function studyProfileFromRaw(raw: RawSharedStudyProfile | null | undefined): SharedStudyProfile {
  const r = raw ?? {};
  return {
    hasPlan: typeof r.has_plan === 'boolean' ? r.has_plan : DEFAULT_SHARED_STUDY_PROFILE.hasPlan,
    targetScore:
      typeof r.target_score === 'number' ? r.target_score : DEFAULT_SHARED_STUDY_PROFILE.targetScore,
    examDate: typeof r.exam_date === 'string' ? r.exam_date : null,
    dailyMinutes:
      typeof r.daily_minutes === 'number' ? r.daily_minutes : DEFAULT_SHARED_STUDY_PROFILE.dailyMinutes,
    targetLevel: typeof r.target_level === 'string' ? r.target_level : null,
    restDays: Array.isArray(r.rest_days)
      ? r.rest_days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
      : [],
    mockCadenceDays: typeof r.mock_cadence_days === 'number' ? r.mock_cadence_days : null,
    topicWeights:
      r.topic_weights && typeof r.topic_weights === 'object' ? { ...r.topic_weights } : {},
    domainGoals: coerceDomainGoals(r.domain_goals),
    timeAllocation: coerceTimeAllocation(r.time_allocation),
    lastWriter: coerceWriter(r.last_writer),
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
  };
}

/** Build the backend snake_case `PUT` body from a host-side {@link StudyProfilePatch}.
 * Only the keys actually present are included so an unset field is never zeroed
 * on the backend. */
export function studyProfilePatchToRaw(patch: StudyProfilePatch): RawSharedStudyProfile {
  const out: RawSharedStudyProfile = {};
  if (patch.targetScore !== undefined) out.target_score = patch.targetScore;
  if (patch.examDate !== undefined) out.exam_date = patch.examDate;
  if (patch.dailyMinutes !== undefined) out.daily_minutes = patch.dailyMinutes;
  if (patch.targetLevel !== undefined) out.target_level = patch.targetLevel;
  if (patch.restDays !== undefined) out.rest_days = patch.restDays;
  if (patch.mockCadenceDays !== undefined) out.mock_cadence_days = patch.mockCadenceDays;
  if (patch.topicWeights !== undefined) out.topic_weights = patch.topicWeights;
  if (patch.domainGoals !== undefined) out.domain_goals = patch.domainGoals;
  if (patch.timeAllocation !== undefined) out.time_allocation = patch.timeAllocation;
  if (patch.lastWriter !== undefined) out.last_writer = patch.lastWriter;
  return out;
}
