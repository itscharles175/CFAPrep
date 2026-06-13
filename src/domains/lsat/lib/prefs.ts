// Typed localStorage-backed preferences for the test-taking experience
// (docs/06 §4.2, §4.3, §4.6). Everything here is best-effort: a missing or
// malformed value falls back to a sensible default, and writes that fail
// (private mode, quota) are swallowed so the exam UI never crashes.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Confidence } from "./types";
import { STORAGE_KEYS, getJSON, getRaw, setJSON } from "./storage";

// ---------------------------------------------------------------------------
// localStorage keys. Fixed keys come from the central STORAGE_KEYS registry
// (lib/storage.ts); the `*_PREFIX` keys are per-entity (built with an id/date)
// so they stay local here — the prefix STRINGS are part of the on-disk
// contract and must not change.
// ---------------------------------------------------------------------------
const K_READING = STORAGE_KEYS.reading; // ReadingPrefs
const K_RC_SPLIT = STORAGE_KEYS.rcSplit; // number (0..1 fraction of width)
const K_NOTES_PREFIX = "lsatlab.notes."; // + questionId -> MarginNote[]
const K_GOAL = STORAGE_KEYS.goal; // Goal (target score + exam date) — read by Analytics
const K_PLAN_PREFIX = "lsatlab.plan."; // + yyyy-mm-dd -> Record<string, boolean>
const K_BEST_SCORE = STORAGE_KEYS.bestScore; // number — best scaled score seen (for PB confetti)
const K_DENSITY = STORAGE_KEYS.density; // "comfortable" | "compact"
const K_STREAK_FREEZE = STORAGE_KEYS.streakFreeze; // ISO date when freeze was used
const K_ONBOARDING = STORAGE_KEYS.onboardingDone; // boolean
const K_HIGH_CONTRAST = STORAGE_KEYS.highContrast; // boolean
const K_EXAM_KIOSK = STORAGE_KEYS.examKiosk; // boolean — fullscreen on timed exams
const K_MEASURE = STORAGE_KEYS.measureCh; // number 58-75
const K_TIMER = STORAGE_KEYS.timerDefaults; // { lrMin, rcMin }
const K_ACCOMMODATIONS = STORAGE_KEYS.accommodations;
const K_WEEKLY_GOALS = STORAGE_KEYS.weeklyGoals;
const K_REFLECTION_PREFIX = "lsatlab.reflection."; // + sessionId
const K_ANALYTICS_VIEWS = STORAGE_KEYS.analyticsViews;
const K_ANALYTICS_ALERTS = STORAGE_KEYS.analyticsAlertsDismissed;
const K_ANALYTICS_THRESHOLDS = STORAGE_KEYS.analyticsThresholds;
const K_GAP_SNAPSHOT = STORAGE_KEYS.analyticsGapSnapshot;
const K_NAV_MODE = STORAGE_KEYS.navigatorMode; // "default" | "type" | "time"
const K_BR_CONFIDENCE = STORAGE_KEYS.brLastConfidence;
const K_PLAN_BUDGET = STORAGE_KEYS.planBudgetMin;
const K_PLAN_ORDER = "lsatlab.planOrder"; // + yyyy-mm-dd -> string[]
const K_STUDY_NUDGE = STORAGE_KEYS.studyNudgeDismissed;
const K_AI_PREREQ = STORAGE_KEYS.aiPrereqDismissed; // boolean — S3 Ollama/sample-data banner

// ---------------------------------------------------------------------------
// Generic typed get/set — thin aliases over the shared storage helpers so this
// module's many call sites stay terse. (lib/storage.ts owns the try/catch.)
// ---------------------------------------------------------------------------
const get = getJSON;
const set = setJSON;

// ---------------------------------------------------------------------------
// Reading preferences (§4.2)
// ---------------------------------------------------------------------------
export type ReadingSize = "sm" | "md" | "lg";

export type ChoiceSize = "sm" | "md" | "lg";
export type ChoiceSpacing = "tight" | "normal" | "relaxed";

export interface ReadingPrefs {
  size: ReadingSize;
  serif: boolean;
  focusTheme: boolean;
  /** Reading column width in ch (58–75). */
  measureCh: number;
  /** R4-C5 — answer choice letter size. */
  choiceSize: ChoiceSize;
  /** R4-C5 — vertical spacing between choices. */
  choiceSpacing: ChoiceSpacing;
}

export const DEFAULT_READING: ReadingPrefs = {
  size: "sm",
  serif: false,
  focusTheme: false,
  measureCh: 66,
  choiceSize: "md",
  choiceSpacing: "normal",
};

export const READING_SIZES: ReadingSize[] = ["sm", "md", "lg"];

/** One-click reading presets (Round 2). */
export const READING_PRESETS: { id: string; label: string; prefs: ReadingPrefs }[] = [
  { id: "default", label: "Default", prefs: DEFAULT_READING },
  { id: "dense", label: "Dense LR", prefs: { size: "sm", serif: false, focusTheme: false, measureCh: 62, choiceSize: "sm", choiceSpacing: "tight" } },
  { id: "rc", label: "RC passage", prefs: { size: "md", serif: true, focusTheme: true, measureCh: 68, choiceSize: "md", choiceSpacing: "normal" } },
  { id: "focus", label: "Focus paper", prefs: { size: "lg", serif: true, focusTheme: true, measureCh: 72, choiceSize: "lg", choiceSpacing: "relaxed" } },
];

export function applyReadingPreset(id: string): ReadingPrefs {
  const preset = READING_PRESETS.find((p) => p.id === id);
  const next = preset?.prefs ?? DEFAULT_READING;
  set(K_READING, next);
  return next;
}

export function getMeasureCh(): number {
  const v = get<number>(K_MEASURE, DEFAULT_READING.measureCh);
  return Math.min(75, Math.max(58, v));
}

export function applyMeasureCh(ch?: number): void {
  const m = ch ?? getMeasureCh();
  document.documentElement.style.setProperty("--measure", `${m}ch`);
}

/** Map a ReadingPrefs to the `.reading-*` classes (docs/07 §2.2). */
export function readingClasses(p: ReadingPrefs): string {
  const sizeClass =
    p.size === "lg" ? "reading-lg" : p.size === "md" ? "reading-md" : "reading-sm";
  applyMeasureCh(p.measureCh ?? getMeasureCh());
  return `reading ${sizeClass}${p.serif ? " reading-serif" : ""}`;
}

/**
 * Reading prefs hook with localStorage persistence. Shared by TakeSection,
 * BlindReview, Explanation and Exam. The setter merges a partial patch.
 */
export function useReadingPrefs(): [
  ReadingPrefs,
  (patch: Partial<ReadingPrefs>) => void,
] {
  const [prefs, setPrefs] = useState<ReadingPrefs>(() => {
    const p = get<ReadingPrefs>(K_READING, DEFAULT_READING);
    return {
      ...DEFAULT_READING,
      ...p,
      measureCh: p.measureCh ?? getMeasureCh(),
      choiceSize: p.choiceSize ?? DEFAULT_READING.choiceSize,
      choiceSpacing: p.choiceSpacing ?? DEFAULT_READING.choiceSpacing,
    };
  });

  // F22 — lazy-load Newsreader only when serif is first enabled.
  const serifLoadedRef = useRef(false);
  useEffect(() => {
    if (prefs.serif && !serifLoadedRef.current) {
      serifLoadedRef.current = true;
      void import("./serifFont").then(({ ensureSerifFont }) => ensureSerifFont());
    }
  }, [prefs.serif]);

  const update = useCallback((patch: Partial<ReadingPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      if (next.measureCh != null) {
        next.measureCh = Math.min(75, Math.max(58, next.measureCh));
        set(K_MEASURE, next.measureCh);
        applyMeasureCh(next.measureCh);
      }
      set(K_READING, next);
      return next;
    });
  }, []);

  return [prefs, update];
}

// Cycle helpers used by command-palette actions / keyboard.
export function nextReadingSize(s: ReadingSize): ReadingSize {
  const i = READING_SIZES.indexOf(s);
  return READING_SIZES[Math.min(READING_SIZES.length - 1, i + 1)];
}
export function prevReadingSize(s: ReadingSize): ReadingSize {
  const i = READING_SIZES.indexOf(s);
  return READING_SIZES[Math.max(0, i - 1)];
}

// ---------------------------------------------------------------------------
// RC split width (§4.6) — persisted as a fraction (passage column width).
// ---------------------------------------------------------------------------
export function getRcSplit(): number {
  const v = get<number>(K_RC_SPLIT, 0.5);
  return Math.min(0.7, Math.max(0.3, v));
}

export function useRcSplit(): [number, (v: number) => void] {
  const [split, setSplit] = useState<number>(() => getRcSplit());
  const update = useCallback((v: number) => {
    const clamped = Math.min(0.7, Math.max(0.3, v));
    setSplit(clamped);
    set(K_RC_SPLIT, clamped);
  }, []);
  return [split, update];
}

// ---------------------------------------------------------------------------
// Margin notes (§4.3) — anchored to a text selection, keyed by question id.
// Notes resurface on the review screens.
// ---------------------------------------------------------------------------
export interface MarginNote {
  id: string;
  /** Character offsets into the annotated text (stimulus/passage). */
  start: number;
  end: number;
  /** The quoted text the note is anchored to (for resurfacing in review). */
  quote: string;
  body: string;
  createdAt: number;
}

export function getNotes(questionId: number): MarginNote[] {
  return get<MarginNote[]>(`${K_NOTES_PREFIX}${questionId}`, []);
}

export function setNotes(questionId: number, notes: MarginNote[]): void {
  set(`${K_NOTES_PREFIX}${questionId}`, notes);
}

/** Notes hook keyed by question id, persisted to localStorage. */
export function useNotes(
  questionId: number | undefined,
): [MarginNote[], (notes: MarginNote[]) => void] {
  const [notes, setLocal] = useState<MarginNote[]>(() =>
    questionId == null ? [] : getNotes(questionId),
  );

  useEffect(() => {
    setLocal(questionId == null ? [] : getNotes(questionId));
  }, [questionId]);

  const update = useCallback(
    (next: MarginNote[]) => {
      setLocal(next);
      if (questionId != null) setNotes(questionId, next);
    },
    [questionId],
  );

  return [notes, update];
}

export function newNoteId(): string {
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Goal + exam date (§5.2) — written by Settings, read by Dashboard & Analytics.
//
// STORAGE CONTRACT (must match what Analytics reads from localStorage["lsatlab.goal"]):
//   { targetScore: number, examDate: string /* ISO yyyy-mm-dd */,
//     bandLow?: number, bandHigh?: number }
// ---------------------------------------------------------------------------
export interface Goal {
  targetScore: number;
  /** ISO yyyy-mm-dd. */
  examDate: string;
  bandLow?: number;
  bandHigh?: number;
  /** Convenience tuple derived from bandLow/bandHigh or ±2 of targetScore. */
  band?: [number, number];
}

/** Read the persisted goal, or null if none set / malformed. */
export function getGoal(): Goal | null {
  try {
    const raw = getRaw(K_GOAL);
    if (!raw) return null;
    // Tolerate a legacy bare-number target.
    if (/^\d+$/.test(raw.trim())) {
      const t = Number(raw.trim());
      return { targetScore: t, examDate: "", band: [t - 2, t + 2] };
    }
    const obj = JSON.parse(raw) as Partial<Goal> & {
      target?: number;
      band?: [number, number];
    };
    const targetScore = obj.targetScore ?? obj.target;
    if (typeof targetScore !== "number") return null;
    const bandLow = obj.bandLow;
    const bandHigh = obj.bandHigh;
    const band: [number, number] =
      obj.band ??
      (bandLow != null && bandHigh != null
        ? [bandLow, bandHigh]
        : [targetScore - 2, targetScore + 2]);
    return {
      targetScore,
      examDate: typeof obj.examDate === "string" ? obj.examDate : "",
      bandLow,
      bandHigh,
      band,
    };
  } catch {
    return null;
  }
}

/** Persist the goal in the shared contract shape. */
export function setGoal(goal: Goal): void {
  set(K_GOAL, goal);
}

/** Days remaining until the exam (null if no/empty date); can be negative. */
export function daysUntil(isoDate: string): number | null {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Today's plan checked state (§5.6) — keyed by local date so it resets daily.
// ---------------------------------------------------------------------------
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getPlanDone(): Record<string, boolean> {
  return get<Record<string, boolean>>(`${K_PLAN_PREFIX}${todayKey()}`, {});
}

export function setPlanDone(state: Record<string, boolean>): void {
  set(`${K_PLAN_PREFIX}${todayKey()}`, state);
}

// ---------------------------------------------------------------------------
// Best scaled score (§5.3) — used to detect a genuine personal best so confetti
// fires only once. `recordScore` returns true if `score` is a new best.
// ---------------------------------------------------------------------------
export function getBestScore(): number | null {
  const v = get<number | null>(K_BEST_SCORE, null);
  return typeof v === "number" ? v : null;
}

export function recordScore(score: number): boolean {
  const prev = getBestScore();
  if (prev == null || score > prev) {
    set(K_BEST_SCORE, score);
    return prev != null && score > prev; // PB only if we had a prior best to beat
  }
  return false;
}

// ---------------------------------------------------------------------------
// UI density (docs/07 §3.3)
// ---------------------------------------------------------------------------
export type Density = "comfortable" | "compact";

export function getDensity(): Density {
  const v = get<Density>(K_DENSITY, "comfortable");
  return v === "compact" ? "compact" : "comfortable";
}

export function setDensity(d: Density): void {
  set(K_DENSITY, d);
  document.documentElement.dataset.density = d;
}

export function applyDensity(): void {
  document.documentElement.dataset.density = getDensity();
}

// ---------------------------------------------------------------------------
// Onboarding (Wave 4)
// ---------------------------------------------------------------------------
export function isOnboardingDone(): boolean {
  return get<boolean>(K_ONBOARDING, false);
}

export function setOnboardingDone(): void {
  set(K_ONBOARDING, true);
}

// ---------------------------------------------------------------------------
// Streak freeze (Wave 4) — one freeze per calendar week
// ---------------------------------------------------------------------------
export function getStreakFreezeUsedWeek(): string | null {
  return get<string | null>(K_STREAK_FREEZE, null);
}

export function getHighContrast(): boolean {
  return get<boolean>(K_HIGH_CONTRAST, false);
}

export function setHighContrast(on: boolean): void {
  set(K_HIGH_CONTRAST, on);
  document.documentElement.classList.toggle("high-contrast", on);
}

/** C7 — opt-in OS fullscreen (kiosk) when a timed exam starts. Default off. */
export function getExamKiosk(): boolean {
  return get<boolean>(K_EXAM_KIOSK, false);
}

export function setExamKiosk(on: boolean): void {
  set(K_EXAM_KIOSK, on);
}

export function applyHighContrast(): void {
  document.documentElement.classList.toggle("high-contrast", getHighContrast());
}

export function applyStreakFreeze(): boolean {
  const now = new Date();
  const weekKey = `${now.getFullYear()}-W${Math.ceil(
    ((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000 + 1) / 7,
  )}`;
  const used = getStreakFreezeUsedWeek();
  if (used === weekKey) return false;
  set(K_STREAK_FREEZE, weekKey);
  return true;
}

// ---------------------------------------------------------------------------
// Timer defaults (R4-H10)
// ---------------------------------------------------------------------------
export interface TimerDefaults {
  lrMin: number;
  rcMin: number;
}

export function getTimerDefaults(): TimerDefaults {
  const v = get<Partial<TimerDefaults>>(K_TIMER, {});
  return {
    lrMin: typeof v.lrMin === "number" ? v.lrMin : 35,
    rcMin: typeof v.rcMin === "number" ? v.rcMin : 35,
  };
}

export function setTimerDefaults(t: TimerDefaults): void {
  set(K_TIMER, t);
}

/** Apply extra-time % to section seconds. */
export function adjustedTimeLimitSec(
  baseSec: number,
  sectionType: "LR" | "RC" | string,
): number {
  const acc = getAccommodations();
  const pct = acc.extraTimePct;
  const min =
    sectionType === "RC" ? getTimerDefaults().rcMin : getTimerDefaults().lrMin;
  const fromMin = min * 60;
  const base = baseSec > 0 ? baseSec : fromMin;
  return Math.round(base * (1 + pct / 100));
}

// ---------------------------------------------------------------------------
// Accommodations (R4-C1)
// ---------------------------------------------------------------------------
export interface Accommodations {
  extraTimePct: number;
  breakMin: number;
  hideTimerDefault: boolean;
}

export const DEFAULT_ACCOMMODATIONS: Accommodations = {
  extraTimePct: 0,
  breakMin: 10,
  hideTimerDefault: false,
};

export function getAccommodations(): Accommodations {
  return { ...DEFAULT_ACCOMMODATIONS, ...get(K_ACCOMMODATIONS, {}) };
}

export function setAccommodations(a: Accommodations): void {
  set(K_ACCOMMODATIONS, a);
}

// ---------------------------------------------------------------------------
// Weekly goals (R4-G3)
// ---------------------------------------------------------------------------
export interface WeeklyGoals {
  questionsTarget: number;
  minutesTarget: number;
}

export function getWeeklyGoals(): WeeklyGoals {
  const v = get<Partial<WeeklyGoals>>(K_WEEKLY_GOALS, {});
  return {
    questionsTarget: v.questionsTarget ?? 100,
    minutesTarget: v.minutesTarget ?? 300,
  };
}

export function setWeeklyGoals(g: WeeklyGoals): void {
  set(K_WEEKLY_GOALS, g);
}

// ---------------------------------------------------------------------------
// Session reflection notes (R4-G4)
// ---------------------------------------------------------------------------
export function getReflection(sessionId: number): string {
  return get<string>(K_REFLECTION_PREFIX + sessionId, "");
}

export function setReflection(sessionId: number, note: string): void {
  set(K_REFLECTION_PREFIX + sessionId, note);
}

// ---------------------------------------------------------------------------
// Saved analytics views (R4-E1)
// ---------------------------------------------------------------------------
export interface SavedAnalyticsView {
  id: string;
  name: string;
  tab: string;
  range: string;
  source: string;
  comparePrior: boolean;
}

export function getSavedAnalyticsViews(): SavedAnalyticsView[] {
  return get<SavedAnalyticsView[]>(K_ANALYTICS_VIEWS, []);
}

export function saveAnalyticsView(view: SavedAnalyticsView): void {
  const list = getSavedAnalyticsViews().filter((v) => v.id !== view.id);
  set(K_ANALYTICS_VIEWS, [...list, view]);
}

export function deleteAnalyticsView(id: string): void {
  set(
    K_ANALYTICS_VIEWS,
    getSavedAnalyticsViews().filter((v) => v.id !== id),
  );
}

export function getAnalyticsAlertsDismissed(): string {
  return get<string>(K_ANALYTICS_ALERTS, "");
}

export function dismissAnalyticsAlertsToday(): void {
  set(K_ANALYTICS_ALERTS, new Date().toISOString().slice(0, 10));
}

// ---------------------------------------------------------------------------
// Analytics alert thresholds (R4-E9)
// ---------------------------------------------------------------------------
export interface AnalyticsAlertThresholds {
  /** Min timed→BR gap (0–1) before alerting, e.g. 0.08 = 8 pts. */
  gapMin: number;
  /** Min increase vs last snapshot to count as "widening". */
  widenMin: number;
}

const DEFAULT_ANALYTICS_THRESHOLDS: AnalyticsAlertThresholds = {
  gapMin: 0.08,
  widenMin: 0.03,
};

export function getAnalyticsAlertThresholds(): AnalyticsAlertThresholds {
  const v = get<AnalyticsAlertThresholds>(
    K_ANALYTICS_THRESHOLDS,
    DEFAULT_ANALYTICS_THRESHOLDS,
  );
  return {
    gapMin: Math.min(0.5, Math.max(0.02, v.gapMin ?? DEFAULT_ANALYTICS_THRESHOLDS.gapMin)),
    widenMin: Math.min(0.3, Math.max(0.01, v.widenMin ?? DEFAULT_ANALYTICS_THRESHOLDS.widenMin)),
  };
}

export function setAnalyticsAlertThresholds(t: AnalyticsAlertThresholds): void {
  set(K_ANALYTICS_THRESHOLDS, t);
}

export interface AnalyticsGapSnapshot {
  capturedAt: string;
  by_type: Record<string, number>;
}

export function getAnalyticsGapSnapshot(): AnalyticsGapSnapshot | null {
  return get<AnalyticsGapSnapshot | null>(K_GAP_SNAPSHOT, null);
}

export function setAnalyticsGapSnapshot(snapshot: AnalyticsGapSnapshot): void {
  set(K_GAP_SNAPSHOT, snapshot);
}

// ---------------------------------------------------------------------------
// Navigator display mode (R4-C6)
// ---------------------------------------------------------------------------
export type NavigatorMode = "default" | "type" | "time";

export function getNavigatorMode(): NavigatorMode {
  const v = get<NavigatorMode>(K_NAV_MODE, "default");
  return v === "type" || v === "time" ? v : "default";
}

export function setNavigatorMode(m: NavigatorMode): void {
  set(K_NAV_MODE, m);
}

// ---------------------------------------------------------------------------
// Blind review confidence (R4-D2)
// ---------------------------------------------------------------------------
export function getBrLastConfidence(): Confidence {
  const v = get<string>(K_BR_CONFIDENCE, "likely");
  return v === "sure" || v === "guess" ? v : "likely";
}

export function setBrLastConfidence(c: Confidence): void {
  set(K_BR_CONFIDENCE, c);
}

// ---------------------------------------------------------------------------
// Today plan v2 (R4-A7)
// ---------------------------------------------------------------------------
export function getPlanBudgetMin(): number {
  const v = get<number>(K_PLAN_BUDGET, 60);
  return Math.min(240, Math.max(15, typeof v === "number" ? v : 60));
}

export function setPlanBudgetMin(min: number): void {
  set(K_PLAN_BUDGET, Math.min(240, Math.max(15, min)));
}

export function getPlanOrder(): string[] {
  return get<string[]>(`${K_PLAN_ORDER}.${todayKey()}`, []);
}

export function setPlanOrder(ids: string[]): void {
  set(`${K_PLAN_ORDER}.${todayKey()}`, ids);
}

// ---------------------------------------------------------------------------
// Study nudge dismiss (R4-G9)
// ---------------------------------------------------------------------------
export function isStudyNudgeDismissed(): boolean {
  const v = get<string>(K_STUDY_NUDGE, "");
  return v === todayKey();
}

export function dismissStudyNudge(): void {
  set(K_STUDY_NUDGE, todayKey());
}

// ---------------------------------------------------------------------------
// S3 — AI prerequisite / sample-data banner dismissal (persistent until the
// user starts Ollama; non-blocking).
// ---------------------------------------------------------------------------
export function isAiPrereqDismissed(): boolean {
  return get<boolean>(K_AI_PREREQ, false);
}

export function setAiPrereqDismissed(dismissed: boolean): void {
  set(K_AI_PREREQ, dismissed);
}
