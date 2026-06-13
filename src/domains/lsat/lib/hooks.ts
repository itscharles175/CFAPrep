// TanStack Query hooks. Each query falls back to local sample data when the
// backend is unreachable, so screens render during frontend development.
import {
  keepPreviousData,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError, api } from "./api";
import { ApiValidationError } from "./apiSchemas";
import { setOfflineMode } from "./offline";
import * as sample from "./sample";
import type {
  AdaptivityPlan,
  AbilityMatrix,
  ActivityEvent,
  ArtifactVersion,
  BacklinkRecord,
  BenchmarkRunRecord,
  BackupIntegrity,
  BackupList,
  BankAudit,
  CoachSnapshot,
  ContentHealth,
  ContentRevalidationReport,
  ContentSourceRegistry,
  ContentVersionFilters,
  ContentVersionRecord,
  ContextPreset,
  CoverageRow,
  DuplicateCluster,
  FeedbackCohortSummary,
  FeedbackOutcomeSummary,
  Forecast,
  FocusQuality,
  GenDrift,
  GenJobSummary,
  KnowledgeInboxItem,
  MigrationPreview,
  GenQuality,
  MasteryRow,
  NotebookCapabilities,
  NotebookChatSession,
  NotebookNote,
  NotebookPage,
  NotebookSearchResult,
  NotebookSource,
  ObservabilityStatus,
  PodcastEpisode,
  PrepTestProgress,
  Question,
  RCDashboard,
  RCPassageMap,
  ReadinessStatus,
  RegressionAlerts,
  Reflection,
  ReleaseTrustManifest,
  RuntimeEvidence,
  ScheduledTaskRecord,
  Settings,
  StudyPlan,
  TodayPlan,
  TransformationRun,
  TypeAnalytics,
  ValidatorRunRecord,
  WorkspaceManifest,
} from "./types";
import {
  DEFAULT_NOTEBOOK_CAPABILITIES,
  normalizeNotebookCapabilities,
} from "./notebookCapabilities";

const STALE = 30_000;

/**
 * True only for a GENUINE connectivity failure — the backend could not be
 * reached at all. `fetch()` rejects with a `TypeError` ("Failed to fetch") when
 * the host is down / DNS fails / the connection is refused, and with a
 * `DOMException` named `AbortError`/`TimeoutError` on an aborted or timed-out
 * request. Those are the only cases that mean "offline".
 *
 * Crucially this is FALSE for an {@link ApiError} (the backend answered with a
 * 4xx/5xx — it is reachable) and FALSE for an {@link ApiValidationError} (the
 * backend answered but the shape drifted). Those must surface, not be disguised
 * as offline.
 */
function isConnectivityError(err: unknown): boolean {
  if (err instanceof ApiError || err instanceof ApiValidationError) return false;
  // Native fetch network failure.
  if (err instanceof TypeError) return true;
  // Aborted / timed-out request (DOMException, or anything carrying the name).
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

// Wrap a fetcher so that a genuine connectivity failure (backend unreachable)
// resolves to local sample data and flips offline mode on — the real
// backend-down feature. Any other error is RE-THROWN so it enters the query's
// error state instead of being hidden behind `usingSample`:
//  - `ApiValidationError` (zod contract drift) reaches the ErrorBoundary, and
//  - a real HTTP 4xx/5xx from a reachable backend surfaces rather than
//    masquerading as "offline" + stale sample data.
// Exported for unit testing (7.2); the `react-refresh/only-export-components`
// rule is intentionally off here (this module is hooks/helpers, not a component).
export function withFallback<T>(fetcher: () => Promise<T>, fallback: T) {
  return async (): Promise<{ data: T; usingSample: boolean }> => {
    try {
      const data = await fetcher();
      setOfflineMode(false);
      return { data, usingSample: false };
    } catch (err) {
      if (isConnectivityError(err)) {
        setOfflineMode(true);
        return { data: fallback, usingSample: true };
      }
      // Backend was reachable (HTTP error) or returned a malformed shape
      // (validation error). We are not offline; surface the error.
      setOfflineMode(false);
      throw err;
    }
  };
}

// The envelope every `withFallback` query resolves to.
type Envelope<T> = { data: T; usingSample: boolean };

/**
 * 7.6 — collapse the `query.data?.data` double-unwrap footgun.
 *
 * Because `withFallback` resolves to `{ data, usingSample }`, every consumer
 * historically reached the payload via `query.data?.data` — easy to write as a
 * single `.data` and get the envelope by mistake. `unwrap` takes a query result
 * and returns a flat view: `data` is the payload (or `undefined` before the
 * first resolve), `usingSample` is hoisted up, and the common status fields are
 * passed through so call sites can destructure one object.
 *
 * Pure and side-effect-free over the passed result, so it is trivially testable
 * and can be applied to any of the `withFallback` hooks without changing their
 * signatures. Consumers that still want the raw query keep using it directly.
 */
export interface Unwrapped<T> {
  data: T | undefined;
  usingSample: boolean;
  isLoading: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
  refetch: () => void;
}

export function unwrap<T>(query: {
  data?: Envelope<T>;
  isLoading: boolean;
  isError: boolean;
  isPlaceholderData?: boolean;
  error: Error | null;
  refetch: () => unknown;
}): Unwrapped<T> {
  return {
    data: query.data?.data,
    usingSample: query.data?.usingSample ?? false,
    isLoading: query.isLoading,
    isError: query.isError,
    isPlaceholderData: query.isPlaceholderData ?? false,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useDashboard(days?: number) {
  return useQuery({
    queryKey: ["dashboard", days ?? "all"],
    queryFn: withFallback(() => api.dashboard(days), sample.sampleDashboard),
    staleTime: STALE,
    // 7.6 — keep the prior range's data visible (dimmed by the consumer) while
    // the new window loads, instead of flashing a skeleton on every switch.
    placeholderData: keepPreviousData,
  });
}

export function usePrepTests() {
  return useQuery({
    queryKey: ["preptests"],
    queryFn: withFallback(api.prepTests, sample.samplePrepTests),
    staleTime: STALE,
  });
}

export function usePrepTest(id: number) {
  return useQuery({
    queryKey: ["preptest", id],
    queryFn: withFallback(() => api.prepTest(id), sample.samplePrepTestDetail),
    staleTime: STALE,
  });
}

export function useSection(id: number) {
  return useQuery({
    queryKey: ["section", id],
    queryFn: withFallback(() => api.section(id), sample.sampleSection(id)),
    staleTime: STALE,
    enabled: id > 0,
  });
}

/**
 * A drill / smart-set session's curated question set, section-shaped so the
 * runner (`/take/session/:id`) can play it. Mirrors `useSection`'s envelope.
 */
export function useDrillSession(sessionId: number) {
  return useQuery({
    queryKey: ["drill-session", sessionId],
    queryFn: withFallback(
      () => api.drillSession(sessionId),
      sample.sampleSection(sessionId),
    ),
    staleTime: STALE,
    enabled: sessionId > 0,
  });
}

export function useQuestion(
  id: number,
  includeExplanation = false,
  opts?: { attemptId?: number | null; sessionId?: number | null },
) {
  return useQuery({
    queryKey: [
      "question",
      id,
      includeExplanation,
      opts?.attemptId ?? null,
      opts?.sessionId ?? null,
    ],
    queryFn: withFallback(
      () => api.question(id, includeExplanation, opts),
      sample.sampleReviewQuestion,
    ),
    staleTime: STALE,
    enabled: id > 0,
  });
}

// ---------------------------------------------------------------------------
// 7.6 — prefetch-on-intent. Warming a section/preptest query on hover or
// pointer-down of a "Start" entry makes the subsequent navigation feel instant.
// These mirror the exact queryKey + queryFn (the `withFallback` wrapper shape)
// of `useSection`/`usePrepTest` so the prefetched cache entry is read directly
// by the destination hook. Best-effort: `withFallback` already swallows network
// errors into a sample fallback, so a prefetch never throws while offline.
// ---------------------------------------------------------------------------
export function prefetchSection(qc: QueryClient, id: number): void {
  if (!(id > 0)) return;
  void qc.prefetchQuery({
    queryKey: ["section", id],
    queryFn: withFallback(() => api.section(id), sample.sampleSection(id)),
    staleTime: STALE,
  });
}

export function prefetchPrepTest(qc: QueryClient, id: number): void {
  if (!(id > 0)) return;
  void qc.prefetchQuery({
    queryKey: ["preptest", id],
    queryFn: withFallback(() => api.prepTest(id), sample.samplePrepTestDetail),
    staleTime: STALE,
  });
}

export function useByType(
  source: "official" | "all",
  days?: number,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["by-type", source, days ?? "all"],
    queryFn: withFallback(() => api.byType(source, days), sample.sampleByType),
    staleTime: STALE,
    placeholderData: keepPreviousData,
    enabled: opts?.enabled ?? true,
  });
}

export function useTiming(sessionId: number) {
  return useQuery({
    queryKey: ["timing", sessionId],
    queryFn: withFallback(() => api.timing(sessionId), sample.sampleTiming),
    staleTime: STALE,
  });
}

export function useBlindReviewGap(days?: number, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["br-gap", days ?? "all"],
    queryFn: withFallback(() => api.blindReviewGap(days), sample.sampleGap),
    staleTime: STALE,
    placeholderData: keepPreviousData,
    enabled: opts?.enabled ?? true,
  });
}

export function useTraps(days?: number) {
  return useQuery({
    queryKey: ["traps", days ?? "all"],
    queryFn: withFallback(() => api.traps(days), sample.sampleTraps),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useByDifficulty(source: "official" | "all", days?: number) {
  return useQuery({
    queryKey: ["by-difficulty", source, days ?? "all"],
    queryFn: withFallback(
      () => api.byDifficulty(source, days),
      sample.sampleDifficulty,
    ),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useRegressionAlerts(
  source: "official" | "all" = "all",
  opts?: { enabled?: boolean; recentDays?: number; baselineDays?: number; minAttempts?: number },
) {
  const recentDays = opts?.recentDays ?? 7;
  const baselineDays = opts?.baselineDays ?? 30;
  const minAttempts = opts?.minAttempts ?? 6;
  return useQuery({
    queryKey: ["regression-alerts", source, recentDays, baselineDays, minAttempts],
    queryFn: withFallback(
      () => api.regressionAlerts(source, recentDays, baselineDays, minAttempts),
      {
        model: "silent_regression_v1",
        source,
        recent_days: recentDays,
        baseline_days: baselineDays,
        min_attempts: minAttempts,
        min_drop: 0.15,
        status: "insufficient_data",
        alerts: [],
        summary: {
          alert_count: 0,
          checked_types: 0,
          insufficient_types: 0,
          recent_window_start: "",
          baseline_window_start: "",
        },
        insufficient: [],
      } as RegressionAlerts,
    ),
    staleTime: STALE,
    placeholderData: keepPreviousData,
    enabled: opts?.enabled ?? true,
  });
}

export function useSessions(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: withFallback(api.sessions, sample.sampleSessions),
    staleTime: STALE,
    enabled: opts?.enabled ?? true,
  });
}

export function useActivity(days = 120, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["activity", days],
    queryFn: withFallback(() => api.activity(days), sample.sampleActivity),
    staleTime: STALE,
    placeholderData: keepPreviousData,
    enabled: opts?.enabled ?? true,
  });
}

export function useSrsDue(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["srs-due"],
    queryFn: withFallback(api.srsDue, sample.sampleSrs),
    staleTime: STALE,
    enabled: opts?.enabled ?? true,
  });
}

export function useErrorLog() {
  return useQuery({
    queryKey: ["error-log"],
    queryFn: withFallback(api.errorLog, sample.sampleErrorLog),
    staleTime: STALE,
  });
}

export function useSessionResults(sessionId: number) {
  return useQuery({
    queryKey: ["results", sessionId],
    queryFn: withFallback(
      () => api.sessionResults(sessionId),
      sample.sampleResults,
    ),
    staleTime: STALE,
    // Skip the spurious /api/sessions/0/results call when there is no selected
    // session (id 0), mirroring useQuestion/usePlaylist.
    enabled: sessionId > 0,
  });
}

export function useGenQuarantine() {
  return useQuery({
    queryKey: ["gen-quarantine"],
    queryFn: withFallback(() => api.genQuarantine(), [] as Question[]),
    staleTime: STALE,
  });
}

export function useAiHealth() {
  return useQuery({
    queryKey: ["ai-health"],
    queryFn: withFallback(api.aiHealth, {
      ollama: false,
      models: ["qwen3:8b", "qwen3:14b"],
      explain_model: "qwen3:8b",
      gen_model: "qwen3:14b",
    }),
    staleTime: STALE,
  });
}

// --- vNext adaptive tutor cockpit -----------------------------------------
export function useAdaptivityAbility(days = 180) {
  return useQuery({
    queryKey: ["adaptivity-ability", days],
    queryFn: withFallback(
      () => api.adaptivityAbility(days),
      {
        overall: {
          q_type: null,
          section_type: null,
          ability: 0,
          mastery: 0.5,
          uncertainty: 1,
          evidence_n: 0,
          accuracy: null,
          avg_time_ms: null,
          components: {},
        },
        by_type: [],
        weakest: [],
      } as AbilityMatrix,
    ),
    staleTime: STALE,
  });
}

export function useAdaptivityPlan(minutes = 60) {
  return useQuery({
    queryKey: ["adaptivity-plan", minutes],
    queryFn: withFallback(
      () => api.adaptivityPlan(minutes),
      {
        minutes,
        ability: {
          q_type: null,
          section_type: null,
          ability: 0,
          mastery: 0.5,
          uncertainty: 1,
          evidence_n: 0,
          accuracy: null,
          avg_time_ms: null,
          components: {},
        },
        weakest: [],
        tasks: [],
      } as AdaptivityPlan,
    ),
    staleTime: STALE,
  });
}

export function useReadinessStatus(sectionType?: "LR" | "RC" | null, days?: number | null) {
  return useQuery({
    queryKey: ["readiness-vnext", sectionType ?? "all", days ?? "all"],
    queryFn: withFallback(
      () => api.readiness(sectionType ?? null, false, days ?? null),
      {
        section_type: sectionType ?? null,
        readiness_score: 0,
        status: "needs_foundation",
        on_track: null,
        exam_ready: false,
        predicted_scaled_score: null,
        components: {
          mastery: 0,
          accuracy: null,
          blind_review_control: 0,
          evidence: 0,
          srs_load: 0,
          attempts_90d: 0,
          due_srs: 0,
          evidence_days: days ?? null,
          ability_days: days ?? null,
        },
        ability: {
          q_type: null,
          section_type: sectionType ?? null,
          ability: 0,
          mastery: 0,
          uncertainty: 1,
          evidence_n: 0,
          accuracy: null,
          avg_time_ms: null,
          components: {},
        },
      } as ReadinessStatus,
    ),
    staleTime: STALE,
  });
}

export function useFeedbackCohorts(days?: number | null) {
  const windowDays = days ?? 90;
  return useQuery({
    queryKey: ["feedback-cohorts", windowDays],
    queryFn: withFallback(
      () => api.feedbackCohorts(windowDays),
      {
        model: "daily_plan_feedback_cohorts_v1",
        window_days: windowDays,
        generated_at: "",
        total_events_seen: 0,
        total: 0,
        complete: 0,
        skip: 0,
        reopen: 0,
        completion_rate: null,
        skip_rate: null,
        reopen_rate: null,
        minutes_completed: 0,
        avg_utility_score: null,
        selector_adjustment: 0,
        status: "no_feedback",
        latest_at: null,
        by_q_type: {},
        by_task_type: {},
        q_type_cohorts: [],
        task_type_cohorts: [],
        top_q_type: null,
      } as FeedbackCohortSummary,
    ),
    staleTime: STALE,
  });
}

export function useFeedbackOutcomes(
  feedbackDays?: number | null,
  outcomeDays = 30,
  source: "official" | "all" = "all",
  minAttempts = 3,
) {
  const windowDays = feedbackDays ?? 90;
  return useQuery({
    queryKey: ["feedback-outcomes", windowDays, outcomeDays, source, minAttempts],
    queryFn: withFallback(
      () => api.feedbackOutcomes(windowDays, outcomeDays, source, minAttempts),
      {
        model: "daily_plan_feedback_outcomes_v1",
        feedback_window_days: windowDays,
        outcome_window_days: outcomeDays,
        source,
        min_attempts: minAttempts,
        generated_at: "",
        total_feedback_events_seen: 0,
        qualifying_feedback_events: 0,
        cohorts: [],
        by_q_type: {},
        summary: {
          status: "no_feedback",
          cohort_count: 0,
          planner_ready_cohorts: 0,
          best_lift_q_type: null,
          best_lift_action: null,
          best_lift_delta: null,
        },
      } as FeedbackOutcomeSummary,
    ),
    staleTime: STALE,
  });
}

export function useContentHealth() {
  return useQuery({
    queryKey: ["content-health"],
    queryFn: withFallback(
      api.contentHealth,
      {
        total_questions: 0,
        score: 0,
        status: "warning",
        warnings: ["backend_offline"],
        by_source: {},
        by_q_type: {},
        tag_confidence: { low: 0, low_question_ids: [] },
        quarantine: { count: 0, question_ids: [] },
        duplicates: { clusters: [], cluster_count: 0 },
        official_firewall: {
          ok: true,
          training_eligible_official_count: 0,
          question_ids: [],
        },
        validator_coverage: {
          ai_without_validator_count: 0,
          ai_without_validator_question_ids: [],
          known_validator_types: [],
        },
        choice_integrity: { nonstandard_choice_count: 0, question_ids: [] },
        versioning: { snapshots: 0, by_entity: {} },
        provenance_score: {
          score: 0,
          status: "warning",
          summary: "Backend offline; provenance score unavailable.",
          blocked_source_keys: [],
          warning_source_keys: ["backend_offline"],
          sources: [],
        },
      } as ContentHealth,
    ),
    staleTime: STALE,
  });
}

export function useContentRevalidation(limit = 50) {
  return useQuery({
    queryKey: ["content-revalidation", limit],
    queryFn: withFallback(
      () => api.contentRevalidation(limit),
      {
        approved_ai_count: 0,
        due_count: 0,
        failed_count: 0,
        rc_count: 0,
        missing_evidence_count: 0,
        queue: [],
        recent_failures: [],
        lookback: 0,
        mode: "offline",
      } as ContentRevalidationReport,
    ),
    staleTime: STALE,
  });
}

export function useReleaseTrust(tier: "dev" | "release" | "packaged" = "dev") {
  return useQuery({
    queryKey: ["release-trust", tier],
    queryFn: withFallback(
      () => api.releaseTrust(tier),
      {
        schema: "lsatlab.release_trust.v1",
        tier,
        status: "warning",
        score: 0,
        generated_at: new Date(0).toISOString(),
        app_version: "unknown",
        environment: {},
        checks: {
          backend_offline: {
            status: "warn",
            summary: "Backend unavailable; trust manifest is using fallback data.",
            detail: {},
            action: "Start or restart the local backend.",
          },
        },
        blockers: [],
        warnings: [
          {
            check: "backend_offline",
            summary: "Backend unavailable; trust manifest is using fallback data.",
            action: "Start or restart the local backend.",
          },
        ],
        next_actions: ["Start or restart the local backend."],
      } as ReleaseTrustManifest,
    ),
    staleTime: 15_000,
  });
}

export function useMigrationPreview() {
  return useQuery({
    queryKey: ["migration-preview"],
    queryFn: withFallback(
      api.migrationPreview,
      {
        latest_expected_version: 0,
        pragma_user_version: 0,
        applied_count: 0,
        pending_count: 0,
        applied: [],
        pending: [],
        failed: [],
        checksum_mismatches: [],
        pre_migration_backup_required: false,
        restore_after_upgrade_smoke_required: false,
      } as MigrationPreview,
    ),
    staleTime: STALE,
  });
}

export function useScheduledTasks() {
  return useQuery({
    queryKey: ["scheduled-tasks"],
    queryFn: withFallback(
      () => api.scheduledTasks(),
      { count: 0, tasks: [] as ScheduledTaskRecord[] },
    ),
    staleTime: STALE,
  });
}

export function useBenchmarkRuns() {
  return useQuery({
    queryKey: ["benchmark-runs"],
    queryFn: withFallback(
      () => api.benchmarkRuns(),
      { count: 0, runs: [] as BenchmarkRunRecord[] },
    ),
    staleTime: STALE,
  });
}

async function fetchNotebookCapabilities(): Promise<NotebookCapabilities> {
  try {
    return normalizeNotebookCapabilities(await api.notebookCapabilities());
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
      return DEFAULT_NOTEBOOK_CAPABILITIES;
    }
    throw err;
  }
}

export function useNotebookCapabilities() {
  return useQuery({
    queryKey: ["notebook-capabilities"],
    queryFn: withFallback(
      fetchNotebookCapabilities,
      DEFAULT_NOTEBOOK_CAPABILITIES,
    ),
    staleTime: 5 * 60_000,
  });
}

export function useNotebookPages(q = "") {
  return useQuery({
    queryKey: ["notebook-pages", q],
    queryFn: withFallback(() => api.notebookPages(q || undefined), [] as NotebookPage[]),
    staleTime: STALE,
  });
}

export function useWorkspaceDefault() {
  return useQuery({
    queryKey: ["notebook-workspace-default"],
    queryFn: withFallback(
      api.workspaceDefault,
      {
        id: 0,
        key: "default",
        title: "LSAT Notebook OS",
        description: "Local evidence graph, sources, notes, and tutor chat.",
        home_artifact_id: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      } as WorkspaceManifest,
    ),
    staleTime: STALE,
  });
}

export function useNotebookSources() {
  return useQuery({
    queryKey: ["notebook-sources"],
    queryFn: withFallback(api.notebookSources, [] as NotebookSource[]),
    staleTime: STALE,
  });
}

export function useNotebookNotes() {
  return useQuery({
    queryKey: ["notebook-notes"],
    queryFn: withFallback(api.notebookNotes, [] as NotebookNote[]),
    staleTime: STALE,
  });
}

export function useNotebookActivity() {
  return useQuery({
    queryKey: ["notebook-activity"],
    queryFn: withFallback(api.activityEvents, [] as ActivityEvent[]),
    staleTime: 10_000,
  });
}

export function useKnowledgeInbox() {
  return useQuery({
    queryKey: ["knowledge-inbox"],
    queryFn: withFallback(api.knowledgeInbox, [] as KnowledgeInboxItem[]),
    staleTime: STALE,
  });
}

export function useBacklinks(target?: string | null) {
  return useQuery({
    queryKey: ["backlinks", target],
    queryFn: withFallback(
      () => api.backlinks(target || ""),
      [] as BacklinkRecord[],
    ),
    enabled: Boolean(target),
    staleTime: STALE,
  });
}

export function useArtifactVersions(artifactId?: number | null) {
  return useQuery({
    queryKey: ["artifact-versions", artifactId],
    queryFn: withFallback(
      () => api.artifactVersions(artifactId || 0),
      [] as ArtifactVersion[],
    ),
    enabled: Boolean(artifactId),
    staleTime: STALE,
  });
}

export function useNotebookChatSessions() {
  return useQuery({
    queryKey: ["notebook-chat-sessions"],
    queryFn: withFallback(api.notebookChatSessions, [] as NotebookChatSession[]),
    staleTime: STALE,
  });
}

export function useNotebookSearch(q: string) {
  return useQuery({
    queryKey: ["notebook-search", q],
    queryFn: withFallback(
      () => api.notebookSearch(q),
      { query: q, artifacts: [], notes: [], sources: [] } as NotebookSearchResult,
    ),
    enabled: q.trim().length > 1,
    staleTime: STALE,
  });
}

export function useTransformations() {
  return useQuery({
    queryKey: ["transformations"],
    queryFn: withFallback(api.transformations, [] as TransformationRun[]),
    staleTime: STALE,
  });
}

export function usePodcasts() {
  return useQuery({
    queryKey: ["podcasts"],
    queryFn: withFallback(api.podcasts, [] as PodcastEpisode[]),
    staleTime: STALE,
  });
}

export function useContextPresets() {
  return useQuery({
    queryKey: ["context-presets"],
    queryFn: withFallback(api.contextPresets, [] as ContextPreset[]),
    staleTime: STALE,
  });
}

export function useRCDashboard() {
  return useQuery({
    queryKey: ["rc-dashboard"],
    queryFn: withFallback(
      api.rcDashboard,
      {
        passages: 0,
        questions: 0,
        mapped_passages: 0,
        coverage: 0,
        by_q_type: {},
        tag_coverage: {
          tagged_questions: 0,
          total_questions: 0,
          coverage: 0,
          low_confidence: 0,
          by_scope: {},
        },
        timing: { attempts: 0, avg_time_ms: null, accuracy: null, by_q_type: {} },
        next_actions: ["Start the backend to analyze RC passages."],
      } as RCDashboard,
    ),
    staleTime: STALE,
  });
}

export function useRCPassageMaps() {
  return useQuery({
    queryKey: ["rc-passage-maps"],
    queryFn: withFallback(api.rcPassageMaps, [] as RCPassageMap[]),
    staleTime: STALE,
  });
}

export function useContentSources() {
  return useQuery({
    queryKey: ["content-sources"],
    queryFn: withFallback(api.contentSources, [] as ContentSourceRegistry[]),
    staleTime: STALE,
  });
}

export function useValidatorRuns() {
  return useQuery({
    queryKey: ["validator-runs"],
    queryFn: withFallback(api.validatorRuns, [] as ValidatorRunRecord[]),
    staleTime: STALE,
  });
}

export function useContentVersions(
  filtersOrEntity?: ContentVersionFilters | string,
  entityId?: number,
) {
  const filters =
    typeof filtersOrEntity === "string"
      ? { entity: filtersOrEntity, entity_id: entityId }
      : filtersOrEntity;
  return useQuery({
    queryKey: ["content-versions", filters ?? "all"],
    queryFn: withFallback(
      () => api.contentVersions(filters),
      [] as ContentVersionRecord[],
    ),
    staleTime: STALE,
  });
}

// --- Round 5 hooks ---------------------------------------------------------
const EMPTY_FORECAST: Forecast = {
  current_score: null, projected_score: null, slope_per_week: 0,
  confidence: null, target_score: null, gap_to_target: null,
  on_track: null, days_to_exam: null, n_points: 0,
};

export function useCoach() {
  return useQuery({
    queryKey: ["coach"],
    queryFn: withFallback(api.coach, { available: false } as CoachSnapshot),
    staleTime: STALE,
  });
}

export function useMastery(source: "official" | "all" = "all", days?: number) {
  return useQuery({
    queryKey: ["mastery", source, days ?? "all"],
    queryFn: withFallback(() => api.mastery(source, days), [] as MasteryRow[]),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useForecast(
  examDate?: string | null,
  targetScore?: number | null,
  days?: number,
) {
  return useQuery({
    queryKey: ["forecast", examDate ?? null, targetScore ?? null, days ?? "all"],
    queryFn: withFallback(
      () => api.forecast(examDate, targetScore, days),
      EMPTY_FORECAST,
    ),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useTypeAnalytics(qType: string, days?: number) {
  return useQuery({
    queryKey: ["type-analytics", qType, days ?? "all"],
    queryFn: withFallback(
      () => api.analyticsType(qType, days),
      {
        q_type: qType,
        overall: { q_type: qType, attempts: 0, accuracy: 0, avg_time_ms: 0, trend: "flat" },
        by_section: {},
        gap: { timed_accuracy: 0, br_accuracy: 0, gap: 0, n: 0 },
        traps: [],
        recent_misses: [],
      } as TypeAnalytics,
    ),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useFocusQuality(sessionId: number) {
  return useQuery({
    queryKey: ["focus", sessionId],
    queryFn: withFallback(
      () => api.focusQuality(sessionId),
      { score: null, components: {}, n: 0 } as FocusQuality,
    ),
    staleTime: STALE,
  });
}

export function useTodayPlan() {
  return useQuery({
    queryKey: ["today-plan"],
    queryFn: withFallback(api.today, {
      has_plan: false, target_score: null, exam_date: null, daily_minutes: null,
      days_to_exam: null, predicted_score: null, forecast: EMPTY_FORECAST,
      due_count: 0, weakest_types: [], tasks: [], utility_model: "offline_fallback",
    } as TodayPlan),
    staleTime: STALE,
  });
}

export function useStudyPlan() {
  return useQuery({
    queryKey: ["study-plan"],
    queryFn: withFallback(api.studyPlan, { has_plan: false } as StudyPlan),
    staleTime: STALE,
  });
}

export function usePrepTestProgress(id: number) {
  return useQuery({
    queryKey: ["pt-progress", id],
    queryFn: withFallback(
      () => api.preptestProgress(id),
      { preptest_id: id, name: "", section_count: 0, sections_done: 0, sections: [] } as PrepTestProgress,
    ),
    staleTime: STALE,
  });
}

export function useObservability() {
  return useQuery({
    queryKey: ["observability"],
    queryFn: withFallback(api.observabilityStatus, {
      gen_queued: 0, gen_running: 0, worker_alive: false,
      last_coach_refresh_ms: null, explain_p50_ms: null, embed_coverage_pct: 0,
      models: {
        realtime_provider: "ollama", offline_provider: "ollama", cloud_enabled: false,
        explain_model: "qwen3:8b", gen_model: "qwen3:14b", diagnose_model: "qwen3:8b",
        embed_model: "nomic-embed-text", cloud_gen_model: null,
      },
    } as ObservabilityStatus),
    staleTime: 15_000,
  });
}

export function useRuntimeEvidence() {
  return useQuery({
    queryKey: ["runtime-evidence"],
    queryFn: withFallback(api.runtimeEvidence, {
      ok: false,
      status: "missing",
      generated_at: new Date(0).toISOString(),
      log_dir: "",
      log_dir_exists: false,
      log_dir_writable: false,
      log_file_count: 0,
      log_files: [],
      recent_error_count: 0,
      recent_errors: [],
      last_request_error: null,
      metrics: { available: false },
      crash_free_window: { status: "unknown" },
    } as RuntimeEvidence),
    staleTime: 15_000,
  });
}

// X2 / D4 — local backups + integrity (Diagnostics panel)
export function useBackups() {
  return useQuery({
    queryKey: ["backups"],
    queryFn: withFallback(api.backupList, { backups: [] } as BackupList),
    staleTime: STALE,
  });
}

export function useBackupIntegrity() {
  return useQuery({
    queryKey: ["backup-integrity"],
    queryFn: withFallback(api.backupIntegrity, { result: "unknown" } as BackupIntegrity),
    staleTime: STALE,
  });
}

export function useGenJobs(limit = 50) {
  return useQuery({
    queryKey: ["gen-jobs", limit],
    queryFn: withFallback(() => api.genJobs(limit), [] as GenJobSummary[]),
    staleTime: 10_000,
  });
}

export function useGenCoverage() {
  return useQuery({
    queryKey: ["gen-coverage"],
    queryFn: withFallback(api.genCoverage, [] as CoverageRow[]),
    staleTime: STALE,
  });
}

export function useBankAudit() {
  return useQuery({
    queryKey: ["bank-audit"],
    queryFn: withFallback(api.bankAudit, {
      total: 0, by_source: {}, missing_q_type: 0, generic_placeholder: 0,
      length_tell: 0, missing_trap_tags: 0, embedded: 0,
    } as BankAudit),
    staleTime: STALE,
  });
}

export function useDuplicates(threshold = 0.95) {
  return useQuery({
    queryKey: ["duplicates", threshold],
    queryFn: withFallback(() => api.bankDuplicates(threshold), [] as DuplicateCluster[]),
    staleTime: STALE,
  });
}

export function useBankTagReview(limit = 50) {
  return useQuery({
    queryKey: ["tag-review", limit],
    queryFn: withFallback(() => api.bankTagReview(limit), [] as Question[]),
    staleTime: STALE,
  });
}

export function useBankStats() {
  return useQuery({
    queryKey: ["bank-stats"],
    queryFn: withFallback(api.bankStats, {
      total: 0,
      by_source: {},
      by_q_type: {},
      available_sources: [],
    }),
    staleTime: STALE,
  });
}

export function useBankSources() {
  return useQuery({
    queryKey: ["bank-sources"],
    queryFn: withFallback(api.bankSources, []),
    staleTime: STALE,
  });
}

// Q2 — generation-quality analytics (pass rate, fail reasons, cloud hints).
export function useGenQuality() {
  return useQuery({
    queryKey: ["gen-quality"],
    queryFn: withFallback(api.genQuality, {
      jobs: 0, total_candidates: 0, passed: 0, quarantined: 0, pass_rate: 0,
      fail_reasons: {}, by_type: {}, cloud_recommended_types: [],
    } as GenQuality),
    staleTime: STALE,
  });
}

// Q5 — approved-AI drift watch (items whose live accuracy fell below a floor).
export function useAiDrift(minAttempts?: number, floor?: number) {
  return useQuery({
    queryKey: ["ai-drift", minAttempts ?? "default", floor ?? "default"],
    queryFn: withFallback(
      () => api.genDrift(minAttempts, floor),
      { checked: 0, flagged: [], min_attempts: minAttempts ?? 0, floor: floor ?? 0 } as GenDrift,
    ),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: withFallback(api.settings, {
      settings: {
        explain_model: "qwen3:8b", gen_model: "qwen3:14b", diagnose_model: "qwen3:8b",
        embed_model: "nomic-embed-text", gen_provider: "ollama", cloud_gen_model: "claude-opus-4-7",
      },
      provider: {
        realtime_provider: "ollama", offline_provider: "ollama", cloud_enabled: false,
        explain_model: "qwen3:8b", gen_model: "qwen3:14b", diagnose_model: "qwen3:8b",
        embed_model: "nomic-embed-text", cloud_gen_model: null,
      },
    } as Settings),
    staleTime: STALE,
  });
}

// Playlists / Smart sets (R7 6.1). Offline falls back to an empty list (these
// are user-created; there is no meaningful sample). The list is invalidated by
// the create/update/delete mutations.
export function usePlaylists() {
  return useQuery({
    queryKey: ["playlists"],
    queryFn: withFallback(api.playlists, [] as import("./types").PlaylistSummary[]),
    staleTime: STALE,
  });
}

export function usePlaylist(id: number) {
  return useQuery({
    queryKey: ["playlist", id],
    queryFn: withFallback(
      () => api.playlist(id),
      { id, name: "", kind: "smart", count: 0 } as import("./types").PlaylistDetail,
    ),
    staleTime: STALE,
    enabled: id > 0,
  });
}

export function useReflection(sessionId: number) {
  return useQuery({
    queryKey: ["reflection", sessionId],
    queryFn: withFallback(
      () => api.reflection(sessionId),
      { exists: false, session_id: sessionId, text: "", prompts: [] } as Reflection,
    ),
    staleTime: STALE,
  });
}
